import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import {
  CUSTOMER_PETS_CLIENT,
  type CustomerPetsClient,
} from '../../chatbot-api/domain/customer-pets.port';
import type { CustomerPet as BackendPet } from '../../chatbot-api/domain/dtos/customer-pets.dto';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  LOCAL_PET_STORE,
  LOCAL_PETS_MAX,
  backendPetPatch,
  backendPetView,
  factsSpecies,
  foldPetName,
  hasPetFacts,
  knownPetsPrompt,
  localCreateBody,
  localPetFacts,
  localPetFromFacts,
  localPetView,
  matchPetForFacts,
  mergeFactsIntoLocal,
  uploadBackoffMs,
  type LocalPet,
  type LocalPetStore,
  type LocalSpecies,
  type PetCandidate,
} from '../domain/customer-pets';
import type { CustomerPet } from '../domain/customer-profile';
import { petFactsConflict, type PetPromptView } from '../domain/pet-facts';
import { CustomerProfileService } from './customer-profile.service';

export const CUSTOMER_PETS_CLOCK = Symbol('CUSTOMER_PETS_CLOCK');
export const CUSTOMER_PETS_ID = Symbol('CUSTOMER_PETS_ID');

/** Backend pets are reread at most this often per sender (staff edit them
 *  in the POS without a feed event); our own writes update the cache. */
export const CUSTOMER_PETS_REFRESH_MS = 60_000;

/** C3: time bound of one task in the per-sender queue (a load, a capture
 *  and their writes; each backend call times out at 10 s). Past it the
 *  queue moves on and the stalled load is never joined again. */
export const CUSTOMER_PETS_TASK_TIMEOUT_MS = 25_000;

/** Bounded process cache, like the profile cache. */
const CACHE_MAX = 2000;

/** Upload key of a local pet (contract §4.1: 1–200 chars, per sucursal). */
export const localPetUploadKey = (customerId: string, localId: string) =>
  `pet-local:${customerId}:${localId}`;

/**
 * Where a sender's pets live:
 *   - `customer`: a backend Customer with its ACTIVE pets (by-phone `pets`);
 *   - `customer_pets_unknown`: a Customer without `pets` (no `pets:read`):
 *     read-only, nothing is ever created blindly;
 *   - `prospect`: no Customer: pets live in the local list (S8);
 *   - `unavailable`: the lookup failed: read-only this turn.
 */
type PetScope =
  | { kind: 'customer'; customerId: string; pets: BackendPet[] }
  | { kind: 'customer_pets_unknown'; customerId: string }
  | { kind: 'prospect' }
  | { kind: 'unavailable' };

interface SenderPets {
  scope: PetScope;
  local: LocalPet[];
  /** False while the local list could not be read: every local write and
   *  upload is refused (a full-replacement write from an unknown base would
   *  erase stored pets) and the next turn reads again. */
  localKnown: boolean;
  loadedAt: number;
}

interface PendingLoad {
  force: boolean;
  started: boolean;
  /** C3: past the task bound: stale, never joined. */
  timedOut: boolean;
  promise: Promise<void>;
}

/** E1: one queue task's fence. Set when the task outlives its bound: from
 *  then on its cache update (`remember`, backend pet cache) and every local
 *  write it would start are refused. */
interface Fence {
  expired: boolean;
}

type Ref =
  | { kind: 'backend'; id: string }
  | { kind: 'local'; id: string }
  | { kind: 'legacy' };

/** `failed` carries the HTTP status or answer kind (for the backoff log).
 *  E2 `forgotten`: stopped by «olvida mis datos» (not a failed attempt).
 *  E3 `not_twin`: the reread pet no longer has the twin's name and species. */
type PatchOutcome =
  | 'ok'
  | 'noop'
  | 'forgotten'
  | 'not_twin'
  | { failed: string };

/**
 * Multi-pet memory (T4b; S1, S2, S5, S6, S8). Every method is best effort and
 * never throws: a pet failure never blocks a reply or an order.
 *
 * `prepare` runs at the start of each turn (the lookup is refreshed at most
 * once a minute) and uploads pending local pets once the sender is a
 * Customer; `afterCheckout` forces it after an order (the checkout may have
 * created the Customer). `capture` applies one statement's facts to the
 * matched pet: PATCH a backend pet (changed fields only), update a local or
 * the legacy single pet, or start a new pet (local first, then uploaded with
 * `pet-local:<customerId>:<localId>` — removed locally only after a 201 or
 * replay 200).
 */
@Injectable()
export class CustomerPetsService {
  private readonly logger = new Logger(CustomerPetsService.name);
  private readonly cache = new Map<string, SenderPets>();
  /** B5: per-sender tail of the serialized pet work (loads, captures and
   *  their local writes); removed when the sender goes idle. */
  private readonly queues = new Map<string, Promise<void>>();
  /** B5: the sender's queued or running prepare (single flight). */
  private readonly loads = new Map<string, PendingLoad>();
  /** E1: per-sender chain of local list I/O (each write, and each load's
   *  read + cache update): a write never overlaps another write of the
   *  sender (even one left in flight by a timed-out task) and is computed
   *  from the list the previous write left. */
  private readonly localIo = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    @Inject(LOCAL_PET_STORE) private readonly localStore: LocalPetStore,
    @Inject(CHATBOT_API_CLIENT)
    private readonly api: Pick<ChatbotApiClient, 'getCustomerByPhone'>,
    @Inject(CUSTOMER_PETS_CLIENT) private readonly client: CustomerPetsClient,
    private readonly profiles: CustomerProfileService,
    @Optional() @Inject(CUSTOMER_PETS_CLOCK) clock?: () => Date,
    @Optional() @Inject(CUSTOMER_PETS_ID) newId?: () => string,
  ) {
    this.now = clock ?? (() => new Date());
    this.newId = newId ?? (() => randomUUID());
  }

  /** Loads (or refreshes, when stale) the sender's pets; uploads pending
   *  local pets of a Customer. */
  async prepare(senderId: string, force = false): Promise<void> {
    if (this.profiles.isForgotten(senderId)) return;
    // Fresh: nothing to do, no need to wait behind a running capture.
    if (!force && this.isFresh(senderId)) return;
    // Single flight: join the sender's pending prepare. A forced one (after
    // an order) joins only a prepare that has not started its lookup yet
    // (and makes it forced); a running one may predate the new Customer.
    // C3: a load that outlived the task bound is stale and never joined.
    const pending = this.loads.get(senderId);
    if (
      pending !== undefined &&
      !pending.timedOut &&
      (!force || !pending.started)
    ) {
      if (force) pending.force = true;
      return pending.promise;
    }
    const entry: PendingLoad = {
      force,
      started: false,
      timedOut: false,
      promise: Promise.resolve(),
    };
    entry.promise = this.serialized(
      senderId,
      async (fence) => {
        entry.started = true;
        try {
          await this.load(senderId, entry.force, fence);
        } finally {
          if (this.loads.get(senderId) === entry) this.loads.delete(senderId);
        }
      },
      () => {
        entry.timedOut = true;
        if (this.loads.get(senderId) === entry) this.loads.delete(senderId);
      },
    );
    this.loads.set(senderId, entry);
    await entry.promise;
  }

  /** After an order: the checkout may have created the Customer (S8). */
  async afterCheckout(senderId: string): Promise<void> {
    await this.prepare(senderId, true);
  }

  /**
   * Applies one statement's facts (`extractPetFacts` or rememberPetDetails)
   * to the matched pet. `legacy` is the single stored pet of the profile
   * (until T6 moves it): facts about it keep updating it like before.
   * Serialized per sender (B5): overlapping captures never lose an entry.
   */
  async capture(
    senderId: string,
    facts: CustomerPet,
    legacy?: CustomerPet,
  ): Promise<void> {
    if (!hasPetFacts(facts) || this.profiles.isForgotten(senderId)) return;
    await this.serialized(senderId, (fence) =>
      this.captureNow(senderId, facts, legacy, fence),
    );
  }

  private isFresh(senderId: string): boolean {
    const state = this.cache.get(senderId);
    return (
      state !== undefined &&
      this.now().getTime() - state.loadedAt < CUSTOMER_PETS_REFRESH_MS
    );
  }

  /** Runs `task` after every earlier task of the sender (never rejects the
   *  queue: a failed task does not block the next one). C3: a task that
   *  outlives CUSTOMER_PETS_TASK_TIMEOUT_MS releases the queue (and its
   *  caller); it may still finish in the background, fenced (E1). */
  private serialized(
    senderId: string,
    task: (fence: Fence) => Promise<void>,
    onTimeout?: () => void,
  ) {
    const previous = this.queues.get(senderId) ?? Promise.resolve();
    const run = previous.then(() => this.bounded(task, onTimeout));
    const tail = run.catch(() => undefined);
    this.queues.set(senderId, tail);
    void tail.then(() => {
      if (this.queues.get(senderId) === tail) this.queues.delete(senderId);
    });
    return run;
  }

  private bounded(
    task: (fence: Fence) => Promise<void>,
    onTimeout: (() => void) | undefined,
  ): Promise<void> {
    const fence: Fence = { expired: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        fence.expired = true;
        this.logger.warn(
          `customer pets task exceeded ${CUSTOMER_PETS_TASK_TIMEOUT_MS} ms: queue released`,
        );
        onTimeout?.();
        resolve();
      }, CUSTOMER_PETS_TASK_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([task(fence), expired]).finally(() =>
      clearTimeout(timer),
    );
  }

  /** E1: runs `step` after every earlier local I/O step of the sender
   *  (never rejects the chain). Steps never wait on another step. */
  private localStep<T>(senderId: string, step: () => Promise<T>): Promise<T> {
    const previous = this.localIo.get(senderId) ?? Promise.resolve();
    const run = previous.then(step);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.localIo.set(senderId, tail);
    void tail.then(() => {
      if (this.localIo.get(senderId) === tail) this.localIo.delete(senderId);
    });
    return run;
  }

  private async load(
    senderId: string,
    force: boolean,
    fence: Fence,
  ): Promise<void> {
    if (this.profiles.isForgotten(senderId)) return;
    if (!force && this.isFresh(senderId)) return;
    try {
      const scope = await this.resolveScope(senderId);
      // E1: the local read and the cache update are one local I/O step (no
      // write lands in between), refused once the task is past its bound.
      const remembered = await this.localStep(senderId, async () => {
        if (fence.expired) return false;
        const state = this.cache.get(senderId);
        let local: LocalPet[];
        let localKnown = true;
        try {
          local = await this.localStore.read(senderId);
        } catch (error) {
          this.warn('local read', error);
          localKnown = state?.localKnown === true;
          local = localKnown && state !== undefined ? state.local : [];
        }
        return this.remember(senderId, fence, {
          scope,
          local,
          localKnown,
          // An unknown local list is never cached as fresh: the next turn reads.
          loadedAt: localKnown ? this.now().getTime() : 0,
        })
          ? localKnown
          : false;
      });
      if (scope.kind === 'customer' && remembered)
        await this.uploadPending(senderId, fence);
    } catch (error) {
      this.warn('prepare', error);
    }
  }

  private async captureNow(
    senderId: string,
    facts: CustomerPet,
    legacy: CustomerPet | undefined,
    fence: Fence,
  ): Promise<void> {
    if (this.profiles.isForgotten(senderId)) return;
    try {
      if (!this.cache.has(senderId)) await this.load(senderId, false, fence);
      const state = this.cache.get(senderId);
      if (state === undefined) return;
      const { scope } = state;
      if (
        scope.kind === 'unavailable' ||
        scope.kind === 'customer_pets_unknown'
      ) {
        // B4: no pet store this turn, but the legacy single pet keeps the
        // baseline merge-only profile write (another pet is never mixed in).
        if (petFactsConflict(legacy, facts)) {
          this.logger.log(`pet facts not stored: pets ${scope.kind}`);
          return;
        }
        await this.profiles.record(senderId, { pet: facts });
        return;
      }
      if (!state.localKnown) {
        this.logger.log('pet facts not stored: local pets unknown');
        return;
      }
      const match = matchPetForFacts<Ref>(
        this.candidates(state, legacy),
        facts,
      );
      switch (match.kind) {
        case 'none':
          this.logger.log('pet facts not stored: no single matching pet');
          return;
        case 'new':
          return await this.addLocal(senderId, state, facts, fence);
        case 'match':
          return await this.applyTo(senderId, state, match.ref, facts, fence);
      }
    } catch (error) {
      this.warn('capture', error);
    }
  }

  /**
   * The «Mascota conocida» prompt part for the sender's known ACTIVE pets
   * (backend, then local, then the legacy one unless a store pet has its
   * name). Only the legacy pet → exactly today's line.
   */
  promptLines(senderId: string, legacy?: CustomerPet): string | null {
    if (this.profiles.isForgotten(senderId)) return null;
    const state = this.cache.get(senderId);
    const views: PetPromptView[] = [];
    if (state?.scope.kind === 'customer')
      views.push(...state.scope.pets.map(backendPetView));
    const now = this.now();
    views.push(
      ...(state === undefined ? [] : this.visibleLocal(state)).map((pet) =>
        localPetView(pet, now),
      ),
    );
    if (legacy !== undefined && Object.keys(legacy).length > 0) {
      const name = legacy.name;
      const shadowed =
        name === undefined
          ? views.length > 0
          : views.some(
              (view) =>
                view.name !== undefined &&
                foldPetName(view.name) === foldPetName(name),
            );
      if (!shadowed) views.push(legacy);
    }
    return knownPetsPrompt(views);
  }

  /* -------------------------------------------------------------- scope */

  private async resolveScope(senderId: string): Promise<PetScope> {
    const phone = parseMexicanWhatsAppPhone(senderId);
    // Without a phone the backend can never resolve a Customer.
    if (phone === null) return { kind: 'prospect' };
    try {
      const lookup = await this.api.getCustomerByPhone(
        phone.phoneCountryCode,
        phone.phone,
      );
      if (lookup?.found !== true || lookup.customer === null)
        return { kind: 'prospect' };
      const { customerId, pets } = lookup.customer;
      return pets === undefined
        ? { kind: 'customer_pets_unknown', customerId }
        : {
            kind: 'customer',
            customerId,
            pets: pets.filter((pet) => pet.status === 'ACTIVE'),
          };
    } catch (error) {
      this.warn('customer lookup', error);
      return { kind: 'unavailable' };
    }
  }

  private candidates(
    state: SenderPets,
    legacy: CustomerPet | undefined,
  ): Array<PetCandidate<Ref>> {
    const out: Array<PetCandidate<Ref>> = [];
    if (state.scope.kind === 'customer')
      for (const pet of state.scope.pets)
        out.push({
          ref: { kind: 'backend', id: pet.id },
          name: pet.name,
          species: backendSpecies(pet),
        });
    for (const pet of this.visibleLocal(state))
      out.push({
        ref: { kind: 'local', id: pet.id },
        ...(pet.name === undefined ? {} : { name: pet.name }),
        ...speciesOf(factsSpecies(localPetFacts(pet, this.now()))),
        nameable: true,
      });
    if (legacy !== undefined && Object.keys(legacy).length > 0) {
      // B3: a legacy pet shadowed by a store pet with the same name and
      // species is that pet: the facts go to the store pet.
      const name = legacy.name;
      const species = factsSpecies(legacy);
      const shadowed =
        name !== undefined &&
        out.some(
          (candidate) =>
            candidate.name !== undefined &&
            foldPetName(candidate.name) === foldPetName(name) &&
            (species === undefined ||
              candidate.species === undefined ||
              candidate.species === species),
        );
      if (!shadowed)
        out.push({
          ref: { kind: 'legacy' },
          ...(name === undefined ? {} : { name }),
          ...speciesOf(species),
          nameable: true,
        });
    }
    return out;
  }

  /**
   * B6: local entries that are not a backend pet already. For a Customer, a
   * local entry (pending or blocked) with the name and species of an ACTIVE
   * backend pet is that pet: no second prompt line, never a match candidate.
   * C2: an entry blocked as ambiguous is never shown nor matched. C5: both
   * sides compare through `twinKey` (OTHER is not a cat).
   */
  private visibleLocal(state: SenderPets): LocalPet[] {
    const local = state.local.filter((pet) => pet.blocked !== 'ambiguous');
    if (state.scope.kind !== 'customer') return local;
    const backendKeys = new Set(
      state.scope.pets.map((pet) => twinKey(pet.name, pet.species)),
    );
    return local.filter((pet) => {
      const body = localCreateBody(pet);
      return (
        body === null || !backendKeys.has(twinKey(body.name, body.species))
      );
    });
  }

  /* ------------------------------------------------------------- writes */

  private async applyTo(
    senderId: string,
    state: SenderPets,
    ref: Ref,
    facts: CustomerPet,
    fence: Fence,
  ): Promise<void> {
    if (ref.kind === 'legacy') {
      // Until T6 the legacy single pet keeps its merge-only profile write.
      await this.profiles.record(senderId, { pet: facts });
      return;
    }
    if (ref.kind === 'backend') {
      if (state.scope.kind !== 'customer') return;
      const pet = state.scope.pets.find((candidate) => candidate.id === ref.id);
      if (pet !== undefined)
        await this.patchBackend(
          senderId,
          state.scope.customerId,
          pet,
          facts,
          fence,
        );
      return;
    }
    // E1: merged into the entry as the list stands when the write runs.
    let outcome = 'gone' as 'gone' | 'conflict' | 'unchanged' | 'changed';
    const wrote = await this.writeLocal(senderId, fence, (current) => {
      const pet = current.find((candidate) => candidate.id === ref.id);
      if (pet === undefined) return null;
      const merged = mergeFactsIntoLocal(pet, facts, this.now());
      if (merged === 'conflict' || merged === 'unchanged') {
        outcome = merged;
        return null;
      }
      outcome = 'changed';
      return current.map((entry) => (entry.id === pet.id ? merged : entry));
    });
    if (outcome === 'conflict') {
      this.logger.log('pet facts not stored: another species');
      return;
    }
    if (outcome === 'gone' || (outcome === 'changed' && !wrote)) return;
    if (state.scope.kind === 'customer')
      await this.uploadPending(senderId, fence);
  }

  private async addLocal(
    senderId: string,
    state: SenderPets,
    facts: CustomerPet,
    fence: Fence,
  ): Promise<void> {
    if (state.local.length >= LOCAL_PETS_MAX) {
      this.logger.warn('pet facts not stored: local pet list is full');
      return;
    }
    const pet = localPetFromFacts(this.newId(), facts, this.now());
    // Write-ahead: the entry (and its id, part of the upload key) is durable
    // before any backend create, so a retry can never duplicate the pet.
    let full = false;
    const wrote = await this.writeLocal(senderId, fence, (current) => {
      if (current.length < LOCAL_PETS_MAX) return [...current, pet];
      full = true;
      return null;
    });
    if (full) this.logger.warn('pet facts not stored: local pet list is full');
    if (!wrote) return;
    if (state.scope.kind === 'customer')
      await this.uploadPending(senderId, fence);
  }

  /** Uploads every uploadable local pet of a Customer (S8). */
  private async uploadPending(senderId: string, fence: Fence): Promise<void> {
    const state = this.cache.get(senderId);
    if (
      state === undefined ||
      state.scope.kind !== 'customer' ||
      !state.localKnown
    )
      return;
    for (const pet of [...state.local])
      await this.upload(senderId, pet.id, fence);
  }

  private async upload(
    senderId: string,
    localId: string,
    fence: Fence,
  ): Promise<void> {
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return;
    const scope = state.scope;
    const pet = state.local.find((entry) => entry.id === localId);
    if (
      pet === undefined ||
      pet.upload?.blocked === true ||
      pet.blocked === 'ambiguous'
    )
      return;
    const current = localCreateBody(pet);
    // Name and species are required by the backend: stays local until known.
    if (current === null) return;
    // The Customer already has a pet with this name (staff created it, or an
    // earlier uncertain create did): merge by PATCH, never a duplicate.
    const key = twinKey(current.name, current.species);
    const same = scope.pets.filter(
      (candidate) => twinKey(candidate.name, candidate.species) === key,
    );
    if (same.length > 1) {
      // C2: several ACTIVE backend pets have this name and species: no new
      // pet, no guess which one to patch; kept blocked for T4c's buttons.
      this.logger.log(
        'pet not uploaded: several backend pets have its name and species (kept local, blocked as ambiguous)',
      );
      await this.updateLocal(senderId, fence, localId, (entry) => ({
        ...entry,
        blocked: 'ambiguous',
      }));
      return;
    }
    if (same.length === 1) {
      // B6/C1: pending or not, the twin gets the facts (staff values kept)
      // and the entry goes; a failed PATCH backs off like a create (C6).
      const backoff = pet.upload ?? pet.merge;
      if (!this.due(backoff?.nextAttemptAt)) return;
      const outcome = await this.patchBackend(
        senderId,
        scope.customerId,
        same[0],
        localPetFacts(pet, this.now()),
        fence,
        key,
      );
      // E2: stopped by «olvida mis datos»: no retry log, no attempt.
      if (outcome === 'forgotten') return;
      // E3: the twin was renamed (or changed species): stays pending.
      if (outcome === 'not_twin') {
        this.logger.log(
          'pet merge stopped: the backend pet no longer has its name and species (kept local)',
        );
        return;
      }
      if (typeof outcome === 'object')
        await this.attemptFailed(
          senderId,
          fence,
          localId,
          'merge',
          outcome.failed,
          backoff?.attempts ?? 0,
        );
      else await this.removeLocal(senderId, fence, localId);
      return;
    }
    // A retry under the same key must send the first attempt's bytes.
    let body = current;
    let attempts = 0;
    if (pet.upload?.customerId === scope.customerId) {
      // B1: no retry before the persisted next attempt time.
      if (!this.due(pet.upload.nextAttemptAt)) return;
      body = pet.upload.body;
      attempts = pet.upload.attempts ?? 0;
    } else {
      const upload = { customerId: scope.customerId, body };
      const frozen = await this.writeLocal(senderId, fence, (current) =>
        current.some((entry) => entry.id === localId)
          ? current.map((entry) =>
              entry.id === localId ? { ...entry, upload } : entry,
            )
          : null,
      );
      if (!frozen) return;
    }
    // C4: re-checked right before the create.
    if (this.profiles.isForgotten(senderId)) return;
    let result: Awaited<ReturnType<CustomerPetsClient['createPet']>>;
    try {
      result = await this.client.createPet(
        scope.customerId,
        body,
        localPetUploadKey(scope.customerId, localId),
      );
    } catch (error) {
      await this.attemptFailed(
        senderId,
        fence,
        localId,
        'create',
        errorStatus(error),
        attempts,
      );
      return;
    }
    switch (result.kind) {
      case 'ok': {
        this.upsertBackend(senderId, fence, result.pet);
        await this.removeLocal(senderId, fence, localId);
        // Facts learned after the first (uncertain) attempt: patch them.
        if (JSON.stringify(current) !== JSON.stringify(body))
          await this.patchBackend(
            senderId,
            scope.customerId,
            result.pet,
            localPetFacts(pet, this.now()),
            fence,
          );
        return;
      }
      case 'PET_LIMIT_REACHED':
        this.logger.warn('pet create refused: PET_LIMIT_REACHED (not stored)');
        await this.removeLocal(senderId, fence, localId);
        return;
      case 'IDEMPOTENCY_KEY_CONFLICT':
        this.logger.warn(
          'pet create refused: IDEMPOTENCY_KEY_CONFLICT (kept local)',
        );
        await this.updateLocal(senderId, fence, localId, (entry) =>
          entry.upload !== undefined
            ? { ...entry, upload: { ...entry.upload, blocked: true } }
            : entry,
        );
        return;
      default:
        await this.attemptFailed(
          senderId,
          fence,
          localId,
          'create',
          result.kind,
          attempts,
        );
    }
  }

  /** B1: true when a persisted next attempt time (if any) has passed. */
  private due(nextAttemptAt: string | undefined): boolean {
    return (
      nextAttemptAt === undefined ||
      Date.parse(nextAttemptAt) <= this.now().getTime()
    );
  }

  /**
   * B1/C6: one more failed create or PATCH merge, persisted with its backoff.
   * One counter per entry: in `upload` once a create body is frozen, else in
   * `merge`.
   */
  private async attemptFailed(
    senderId: string,
    fence: Fence,
    localId: string,
    operation: 'create' | 'merge',
    status: string,
    previous: number,
  ): Promise<void> {
    const attempts = previous + 1;
    const wait = uploadBackoffMs(attempts);
    this.logger.warn(
      `pet ${operation} not done: ${status} (attempt ${attempts}, next in ${Math.round(wait / 60_000)} min, kept local)`,
    );
    const nextAttemptAt = new Date(this.now().getTime() + wait).toISOString();
    await this.updateLocal(senderId, fence, localId, (entry) =>
      entry.upload !== undefined
        ? { ...entry, upload: { ...entry.upload, attempts, nextAttemptAt } }
        : { ...entry, merge: { attempts, nextAttemptAt } },
    );
  }

  /**
   * C1: PATCH only the changed fields. On `PET_VERSION_CONFLICT` reread
   * (`?status=ALL`), accept when the values already match, else retry once
   * with the current version. E3: a twin merge passes the twin's `twin`
   * key; a reread pet without it (renamed, other species) is not patched.
   */
  private async patchBackend(
    senderId: string,
    customerId: string,
    pet: BackendPet,
    facts: CustomerPet,
    fence: Fence,
    twin?: string,
  ): Promise<PatchOutcome> {
    let target = pet;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const diff = backendPetPatch(target, facts);
      if (diff === 'conflict') {
        this.logger.log('pet facts not stored: another species');
        return { failed: 'species conflict' };
      }
      if (diff === null) return attempt === 0 ? 'noop' : 'ok';
      // C4: re-checked right before each PATCH.
      if (this.profiles.isForgotten(senderId)) return 'forgotten';
      let result: Awaited<ReturnType<CustomerPetsClient['patchPet']>>;
      try {
        result = await this.client.patchPet(customerId, target.id, {
          version: target.version,
          ...diff,
        });
      } catch (error) {
        this.warn('pet patch', error);
        return { failed: errorStatus(error) };
      }
      if (result.kind === 'ok') {
        this.upsertBackend(senderId, fence, result.pet);
        return 'ok';
      }
      if (result.kind !== 'PET_VERSION_CONFLICT' || attempt > 0) {
        this.logger.warn(`pet patch not done: ${result.kind}`);
        if (result.kind === 'PET_ARCHIVED' || result.kind === 'PET_NOT_FOUND')
          this.dropBackend(senderId, fence, target.id);
        return { failed: result.kind };
      }
      const fresh = await this.reread(customerId, target.id);
      if (fresh === null || fresh.status !== 'ACTIVE') {
        this.dropBackend(senderId, fence, target.id);
        return { failed: 'PET_VERSION_CONFLICT (reread)' };
      }
      this.upsertBackend(senderId, fence, fresh);
      if (twin !== undefined && twinKey(fresh.name, fresh.species) !== twin)
        return 'not_twin';
      target = fresh;
    }
    return { failed: 'PET_VERSION_CONFLICT' };
  }

  private async reread(
    customerId: string,
    petId: string,
  ): Promise<BackendPet | null> {
    try {
      const listed = await this.client.listPets(customerId, 'ALL');
      return listed.kind === 'ok'
        ? (listed.pets.find((pet) => pet.id === petId) ?? null)
        : null;
    } catch (error) {
      this.warn('pet reread', error);
      return null;
    }
  }

  /* -------------------------------------------------------------- cache */

  /**
   * Replaces the sender's local list with `change(current)` (`null` = no
   * write). E1: runs on the sender's local I/O chain, so `current` is the
   * list the previous write left (never an older snapshot), and is refused
   * once the task is past its bound. A write that lands updates the cached
   * list (it is what the store now holds).
   */
  private writeLocal(
    senderId: string,
    fence: Fence,
    change: (current: LocalPet[]) => LocalPet[] | null,
  ): Promise<boolean> {
    return this.localStep(senderId, async () => {
      // C4: re-checked right before each write (a write would recreate the
      // profile row deleted by «olvida mis datos»).
      if (fence.expired || this.profiles.isForgotten(senderId)) return false;
      const state = this.cache.get(senderId);
      if (state === undefined || !state.localKnown) return false;
      const next = change(state.local);
      if (next === null) return false;
      try {
        await this.localStore.write(senderId, next, this.now());
        state.local = next;
        return true;
      } catch (error) {
        this.warn('local write', error);
        return false;
      }
    });
  }

  /** Replaces one entry of the current list (no write when it is gone). */
  private async updateLocal(
    senderId: string,
    fence: Fence,
    localId: string,
    change: (entry: LocalPet) => LocalPet,
  ): Promise<void> {
    await this.writeLocal(senderId, fence, (current) =>
      current.some((entry) => entry.id === localId)
        ? current.map((entry) => (entry.id === localId ? change(entry) : entry))
        : null,
    );
  }

  /** Removed only after a backend success; a failed write keeps the entry
   *  for a retry (same key, same body → replay). */
  private async removeLocal(
    senderId: string,
    fence: Fence,
    localId: string,
  ): Promise<void> {
    await this.writeLocal(senderId, fence, (current) =>
      current.some((entry) => entry.id === localId)
        ? current.filter((entry) => entry.id !== localId)
        : null,
    );
  }

  /** Our write's answer replaces the cached pet (same position); a new pet
   *  goes last; a non-ACTIVE one leaves the list. E1: not from a fenced
   *  task (the next refresh reads the backend). */
  private upsertBackend(senderId: string, fence: Fence, pet: BackendPet): void {
    if (fence.expired) return;
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return;
    const pets = state.scope.pets;
    if (pet.status !== 'ACTIVE') {
      state.scope.pets = pets.filter((entry) => entry.id !== pet.id);
      return;
    }
    const index = pets.findIndex((entry) => entry.id === pet.id);
    state.scope.pets =
      index === -1
        ? [...pets, pet]
        : pets.map((entry, i) => (i === index ? pet : entry));
  }

  private dropBackend(senderId: string, fence: Fence, petId: string): void {
    if (fence.expired) return;
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return;
    state.scope.pets = state.scope.pets.filter((entry) => entry.id !== petId);
  }

  /** E1: refused (false) once the task is past its bound: a late load never
   *  replaces the cache with an older local list. */
  private remember(senderId: string, fence: Fence, state: SenderPets): boolean {
    if (fence.expired) return false;
    this.cache.delete(senderId);
    this.cache.set(senderId, state);
    if (this.cache.size > CACHE_MAX) {
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
    return true;
  }

  private warn(operation: string, error: unknown): void {
    this.logger.warn(
      `customer pets ${operation} failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}

/** The HTTP status of a failed call when known, else the error name. */
function errorStatus(error: unknown): string {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') return String(status);
  return error instanceof Error ? error.name : 'unknown';
}

function backendSpecies(
  pet: Pick<BackendPet, 'species'>,
): LocalSpecies | 'otro' {
  return pet.species === 'DOG'
    ? 'perro'
    : pet.species === 'CAT'
      ? 'gato'
      : 'otro';
}

/** B6/C5: the twin identity: folded name + species mapped like
 *  `backendSpecies` on both sides (OTHER is never a cat). */
function twinKey(name: string, species: BackendPet['species']): string {
  return `${foldPetName(name)}|${backendSpecies({ species })}`;
}

function speciesOf(species: LocalSpecies | undefined): {
  species?: LocalSpecies;
} {
  return species === undefined ? {} : { species };
}
