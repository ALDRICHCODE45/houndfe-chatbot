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
  petAllergiesOverflow,
  uploadBackoffMs,
  type LocalPet,
  type LocalPetStore,
  type LocalSpecies,
  type PetCandidate,
  type PetFacts,
  type PetStage,
} from '../domain/customer-pets';
import {
  sanitizeProfileText,
  type CustomerPet,
} from '../domain/customer-profile';
import {
  breedSpecies,
  petFactsConflict,
  petLifeStage,
  petSpeciesWord,
  type PetPromptView,
} from '../domain/pet-facts';
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

/** F1: time bound of one local pet store call (read or write, connection
 *  acquire included). Past it the local I/O chain moves on and the local
 *  list is unknown until the next successful read. The store itself must
 *  never let a timed-out write land later: the Postgres store cancels it
 *  server-side within LOCAL_PET_STORE_TIMEOUT_MS (shorter than this bound,
 *  so the write is committed or aborted before the chain moves on). */
export const CUSTOMER_PETS_LOCAL_IO_TIMEOUT_MS = 10_000;

/** Bounded process cache, like the profile cache. */
const CACHE_MAX = 2000;

/** G2: archive `reason` ≤ 280 characters (contract §4.3). */
const ARCHIVE_REASON_MAX = 280;

/** G3: `GET …?status=ALL` answers at most 100 pets (contract §1); the erase
 *  lists again while a full page was deleted, at most this many times. */
const ERASE_PAGE = 100;
const ERASE_ROUNDS_MAX = 5;

/**
 * G4 (T4c-1): one known ACTIVE pet as T4c-2 shows it (buttons). `ref` is
 * `backend:<petId>`, `local:<localId>` or `legacy`; same pets and order as
 * the prompt lines.
 */
export interface KnownPet {
  ref: string;
  name?: string;
  species?: string;
  breed?: string;
  ageLabel?: string;
  stage?: PetStage;
  source: 'backend' | 'local' | 'legacy';
}

/** G4: a local entry blocked as ambiguous and the backend pets it may be. */
export interface AmbiguousPetEntry {
  localId: string;
  name: string;
  species: LocalSpecies;
  candidates: KnownPet[];
}

/**
 * G2: what `forgetPet` did. `archived` (backend), `removed` (local entry),
 * `cleared` (legacy single pet): forgotten. `none` / `ambiguous`: 0 or 2+
 * pets with that name, nothing written. `unavailable`: pets unknown this
 * turn (read-only scope, lookup down, local list unknown, forgotten).
 * `failed`: the write did not land.
 */
export type ForgetPetOutcome =
  | 'archived'
  | 'removed'
  | 'cleared'
  | 'none'
  | 'ambiguous'
  | 'unavailable'
  | 'failed';

/** G4: what `resolveAmbiguous` did. */
export type ResolveAmbiguousOutcome =
  | 'resolved'
  | 'not_found'
  | 'failed'
  | 'unavailable';

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

/** One known pet with its prompt view (prompt lines, `knownPets`). */
interface KnownEntry {
  ref: string;
  source: KnownPet['source'];
  view: PetPromptView;
}

/** G3: one pet delete's outcome; `stop` = no scope or customer gone. */
type EraseOutcome = 'deleted' | 'failed' | { stop: string };

/** F1: a local store call's outcome (`timedOut`: past its bound). */
type StoreAnswer<T> = { ok: true; value: T } | { ok: false; timedOut: boolean };

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
    facts: PetFacts,
    legacy?: CustomerPet,
  ): Promise<void> {
    if (!hasPetFacts(facts) || this.profiles.isForgotten(senderId)) return;
    await this.serialized(senderId, (fence) =>
      this.captureNow(senderId, facts, legacy, fence, false),
    );
  }

  /**
   * G1 (T4c-1): the deterministic «<Nombre> es alérgic[oa] a X» statement.
   * Applied only to the single known pet with that name (never a new pet,
   * never a nameless one); appended to its allergies, deduplicated.
   */
  async captureAllergy(
    senderId: string,
    statement: { name: string; allergies: string },
    legacy?: CustomerPet,
  ): Promise<void> {
    const facts: PetFacts = {
      name: statement.name,
      allergies: statement.allergies,
    };
    if (!hasPetFacts(facts) || this.profiles.isForgotten(senderId)) return;
    await this.serialized(senderId, (fence) =>
      this.captureNow(senderId, facts, legacy, fence, true),
    );
  }

  /**
   * G2 (T4c-1): «Bruno ya no está» / «olvida a Bruno». The single known pet
   * with that name is forgotten: a backend pet is archived with the reason
   * (version-conflict reread), a local entry removed, the legacy single pet
   * cleared. 0 or 2+ matches write nothing. Serialized and fenced like the
   * other pet work; never throws.
   */
  async forgetPet(
    senderId: string,
    name: string,
    reason?: string,
  ): Promise<ForgetPetOutcome> {
    if (this.profiles.isForgotten(senderId)) return 'unavailable';
    let outcome: ForgetPetOutcome = 'unavailable';
    await this.serialized(senderId, async (fence) => {
      try {
        outcome = await this.forgetPetNow(senderId, name, reason, fence);
      } catch (error) {
        this.warn('forget pet', error);
        outcome = 'failed';
      }
    });
    return outcome;
  }

  /**
   * G3 (T4c-1): «olvida mis datos» — deletes every backend pet of the
   * sender's Customer (`?status=ALL`, DELETE with each version; 404 = done).
   * Start it before `CustomerProfileService.forget`: unlike every other
   * method it keeps working once the profile is forgotten. Best effort,
   * bounded by the queue task bound (no new delete after it); never throws.
   */
  async forgetAll(senderId: string): Promise<void> {
    await this.serialized(senderId, async (fence) => {
      try {
        await this.eraseBackendPets(senderId, fence);
      } catch (error) {
        this.warn('erase', error);
      }
    });
  }

  /**
   * G4 (T4c-1): the sender's known ACTIVE pets (same pets and order as the
   * prompt lines), from what this process already loaded. `[]` when not
   * loaded or forgotten.
   */
  knownPets(senderId: string): KnownPet[] {
    if (this.profiles.isForgotten(senderId)) return [];
    return this.knownEntries(senderId, this.profiles.cached(senderId)?.pet).map(
      knownPet,
    );
  }

  /** G4 (T4c-1): local entries blocked as ambiguous (C2) with the backend
   *  pets each may be, for T4c-2's buttons. */
  ambiguousEntries(senderId: string): AmbiguousPetEntry[] {
    if (this.profiles.isForgotten(senderId)) return [];
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return [];
    const out: AmbiguousPetEntry[] = [];
    for (const entry of state.local) {
      if (entry.blocked !== 'ambiguous') continue;
      const body = localCreateBody(entry);
      if (body === null) continue;
      const key = twinKey(body.name, body.species);
      out.push({
        localId: entry.id,
        name: body.name,
        species: body.species === 'CAT' ? 'gato' : 'perro',
        candidates: state.scope.pets
          .filter((pet) => twinKey(pet.name, pet.species) === key)
          .map((pet) =>
            knownPet({
              ref: `backend:${pet.id}`,
              source: 'backend',
              view: backendPetView(pet),
            }),
          ),
      });
    }
    return out;
  }

  /**
   * G4 (T4c-1): the customer picked which backend pet a blocked entry is:
   * its facts PATCH that pet (staff values kept, allergies appended) and the
   * entry is removed. A pet that is not a twin of the entry is refused; a
   * failed PATCH keeps the entry blocked. Serialized and fenced.
   */
  async resolveAmbiguous(
    senderId: string,
    localId: string,
    backendPetId: string,
  ): Promise<ResolveAmbiguousOutcome> {
    if (this.profiles.isForgotten(senderId)) return 'unavailable';
    let outcome: ResolveAmbiguousOutcome = 'unavailable';
    await this.serialized(senderId, async (fence) => {
      try {
        outcome = await this.resolveAmbiguousNow(
          senderId,
          localId,
          backendPetId,
          fence,
        );
      } catch (error) {
        this.warn('resolve ambiguous', error);
        outcome = 'failed';
      }
    });
    return outcome;
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
        const read = await this.storeCall('local read', () =>
          this.localStore.read(senderId),
        );
        if (read.ok) local = read.value;
        else {
          // A failed read keeps a known cached list; F1: a timed-out read
          // makes it unknown (its late answer is ignored).
          localKnown = !read.timedOut && state?.localKnown === true;
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
    facts: PetFacts,
    legacy: CustomerPet | undefined,
    fence: Fence,
    knownOnly: boolean,
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
        // G1: the legacy pet has no allergies; an allergy statement alone
        // has nothing to record there.
        if (knownOnly) {
          this.logger.log(`pet allergies not stored: pets ${scope.kind}`);
          return;
        }
        // B4: no pet store this turn, but the legacy single pet keeps the
        // baseline merge-only profile write (another pet is never mixed in).
        if (petFactsConflict(legacy, facts)) {
          this.logger.log(`pet facts not stored: pets ${scope.kind}`);
          return;
        }
        await this.recordLegacy(senderId, facts);
        return;
      }
      if (!state.localKnown) {
        this.logger.log('pet facts not stored: local pets unknown');
        return;
      }
      const candidates = this.candidates(state, legacy);
      if (knownOnly) {
        // G1: only the single known pet with that name.
        const named = this.named(candidates, facts.name ?? '');
        if (named.length !== 1) {
          this.logger.log(
            'pet allergies not stored: no single pet with that name',
          );
          return;
        }
        return await this.applyTo(senderId, state, named[0].ref, facts, fence);
      }
      const match = matchPetForFacts<Ref>(candidates, facts);
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
    return knownPetsPrompt(
      this.knownEntries(senderId, legacy).map((entry) => entry.view),
    );
  }

  /** The known pets behind the prompt lines and `knownPets`, in order. */
  private knownEntries(
    senderId: string,
    legacy: CustomerPet | undefined,
  ): KnownEntry[] {
    const state = this.cache.get(senderId);
    const out: KnownEntry[] = [];
    if (state?.scope.kind === 'customer')
      for (const pet of state.scope.pets)
        out.push({
          ref: `backend:${pet.id}`,
          source: 'backend',
          view: backendPetView(pet),
        });
    const now = this.now();
    for (const pet of state === undefined ? [] : this.visibleLocal(state))
      out.push({
        ref: `local:${pet.id}`,
        source: 'local',
        view: localPetView(pet, now),
      });
    if (legacy !== undefined && Object.keys(legacy).length > 0) {
      const name = legacy.name;
      const shadowed =
        name === undefined
          ? out.length > 0
          : out.some(
              ({ view }) =>
                view.name !== undefined &&
                foldPetName(view.name) === foldPetName(name),
            );
      if (!shadowed)
        out.push({ ref: 'legacy', source: 'legacy', view: legacy });
    }
    return out;
  }

  /** Candidates whose name folds to `name`'s. */
  private named(
    candidates: Array<PetCandidate<Ref>>,
    name: string,
  ): Array<PetCandidate<Ref>> {
    const key = foldPetName(name);
    if (key === '') return [];
    return candidates.filter(
      (candidate) =>
        candidate.name !== undefined && foldPetName(candidate.name) === key,
    );
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
    facts: PetFacts,
    fence: Fence,
  ): Promise<void> {
    if (ref.kind === 'legacy') {
      // Until T6 the legacy single pet keeps its merge-only profile write.
      await this.recordLegacy(senderId, facts);
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
      if (petAllergiesOverflow(pet.allergies, facts)) this.allergiesOverflow();
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

  /** The legacy single pet's merge-only write (G1: it has no allergies). */
  private async recordLegacy(senderId: string, facts: PetFacts): Promise<void> {
    const { allergies, ...pet } = facts;
    if (allergies !== undefined)
      this.logger.log('pet allergies not stored: legacy pet');
    if (hasPetFacts(pet)) await this.profiles.record(senderId, { pet });
  }

  private allergiesOverflow(): void {
    this.logger.warn(
      'pet allergies not stored: over 500 characters (stored value kept)',
    );
  }

  private async addLocal(
    senderId: string,
    state: SenderPets,
    facts: PetFacts,
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
    let attempts = previous + 1;
    let wait = uploadBackoffMs(attempts);
    let gone = false;
    // F2: persisted even after the task's bound (a create/merge answer can
    // arrive late): applied on the chain to the entry as it stands now, so
    // it never restores an older list; a newer attempt is counted.
    const saved = await this.writeLocal(
      senderId,
      fence,
      (current) => {
        const entry = current.find((candidate) => candidate.id === localId);
        if (entry === undefined) {
          gone = true;
          return null;
        }
        attempts =
          Math.max(previous, (entry.upload ?? entry.merge)?.attempts ?? 0) + 1;
        wait = uploadBackoffMs(attempts);
        const nextAttemptAt = new Date(
          this.now().getTime() + wait,
        ).toISOString();
        return current.map((pet) =>
          pet.id !== localId
            ? pet
            : pet.upload !== undefined
              ? { ...pet, upload: { ...pet.upload, attempts, nextAttemptAt } }
              : { ...pet, merge: { attempts, nextAttemptAt } },
        );
      },
      { backoff: true },
    );
    // F2: the retry log only when its backoff is what the store holds.
    if (saved)
      this.logger.warn(
        `pet ${operation} not done: ${status} (attempt ${attempts}, next in ${Math.round(wait / 60_000)} min, kept local)`,
      );
    else if (gone)
      this.logger.warn(
        `pet ${operation} not done: ${status} (entry already resolved, nothing pending)`,
      );
    else
      this.logger.warn(
        `pet ${operation} not done: ${status} (backoff not saved)`,
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
    facts: PetFacts,
    fence: Fence,
    twin?: string,
  ): Promise<PatchOutcome> {
    let target = pet;
    if (petAllergiesOverflow(pet.allergies, facts)) this.allergiesOverflow();
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

  /* ------------------------------------------- forget, erase, resolve */

  private async forgetPetNow(
    senderId: string,
    name: string,
    reason: string | undefined,
    fence: Fence,
  ): Promise<ForgetPetOutcome> {
    if (this.profiles.isForgotten(senderId)) return 'unavailable';
    if (!this.cache.has(senderId)) await this.load(senderId, false, fence);
    const state = this.cache.get(senderId);
    if (
      state === undefined ||
      state.scope.kind === 'unavailable' ||
      state.scope.kind === 'customer_pets_unknown' ||
      !state.localKnown
    )
      return 'unavailable';
    const matches = this.named(
      this.candidates(state, this.profiles.cached(senderId)?.pet),
      name,
    );
    if (matches.length === 0) return 'none';
    if (matches.length > 1) return 'ambiguous';
    const ref = matches[0].ref;
    switch (ref.kind) {
      case 'legacy':
        return (await this.profiles.clearPet(senderId)) ? 'cleared' : 'failed';
      case 'local':
        return (await this.writeLocal(senderId, fence, (current) =>
          current.some((entry) => entry.id === ref.id)
            ? current.filter((entry) => entry.id !== ref.id)
            : null,
        ))
          ? 'removed'
          : 'failed';
      case 'backend': {
        const { scope } = state;
        if (scope.kind !== 'customer') return 'unavailable';
        const pet = scope.pets.find((candidate) => candidate.id === ref.id);
        if (pet === undefined) return 'none';
        return this.archiveBackend(
          senderId,
          scope.customerId,
          pet,
          sanitizeProfileText(reason, ARCHIVE_REASON_MAX),
          fence,
        );
      }
    }
  }

  /** G2: archive with the version; on `PET_VERSION_CONFLICT` reread
   *  (`?status=ALL`): already archived or gone = done, else retry once. */
  private async archiveBackend(
    senderId: string,
    customerId: string,
    pet: BackendPet,
    reason: string | undefined,
    fence: Fence,
  ): Promise<ForgetPetOutcome> {
    let target = pet;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.profiles.isForgotten(senderId)) return 'unavailable';
      let result: Awaited<ReturnType<CustomerPetsClient['archivePet']>>;
      try {
        result = await this.client.archivePet(customerId, target.id, {
          version: target.version,
          ...(reason === undefined ? {} : { reason }),
        });
      } catch (error) {
        this.warn('pet archive', error);
        return 'failed';
      }
      if (result.kind === 'ok') {
        this.upsertBackend(senderId, fence, result.pet);
        await this.forgetTwinEntries(senderId, fence, target);
        return 'archived';
      }
      if (result.kind === 'PET_ARCHIVED' || result.kind === 'PET_NOT_FOUND') {
        this.dropBackend(senderId, fence, target.id);
        await this.forgetTwinEntries(senderId, fence, target);
        return 'archived';
      }
      if (result.kind !== 'PET_VERSION_CONFLICT' || attempt > 0) {
        this.logger.warn(`pet archive not done: ${result.kind}`);
        return 'failed';
      }
      const fresh = await this.reread(customerId, target.id);
      if (fresh === null || fresh.status !== 'ACTIVE') {
        // Already archived (or deleted) by someone else: forgotten.
        if (fresh === null) this.dropBackend(senderId, fence, target.id);
        else this.upsertBackend(senderId, fence, fresh);
        await this.forgetTwinEntries(senderId, fence, target);
        return 'archived';
      }
      this.upsertBackend(senderId, fence, fresh);
      target = fresh;
    }
    return 'failed';
  }

  /** G2: a local entry with the archived pet's name and species (pending,
   *  hidden by B6) is that pet: removed so it is never uploaded later. The
   *  legacy pet it shadowed (B3 rule) is that pet too: cleared, so it does
   *  not resurface once the archived pet leaves the list. */
  private async forgetTwinEntries(
    senderId: string,
    fence: Fence,
    pet: BackendPet,
  ): Promise<void> {
    const legacy = this.profiles.cached(senderId)?.pet;
    const legacySpecies =
      legacy === undefined ? undefined : factsSpecies(legacy);
    if (
      legacy?.name !== undefined &&
      foldPetName(legacy.name) === foldPetName(pet.name) &&
      (legacySpecies === undefined || legacySpecies === backendSpecies(pet))
    )
      await this.profiles.clearPet(senderId);
    const key = twinKey(pet.name, pet.species);
    await this.writeLocal(senderId, fence, (current) => {
      const next = current.filter((entry) => {
        if (entry.blocked === 'ambiguous') return true;
        const body = localCreateBody(entry);
        return body === null || twinKey(body.name, body.species) !== key;
      });
      return next.length === current.length ? null : next;
    });
  }

  /** G3: the Customer's pets, every page of `?status=ALL`, deleted. */
  private async eraseBackendPets(
    senderId: string,
    fence: Fence,
  ): Promise<void> {
    const cached = this.cache.get(senderId)?.scope;
    this.cache.delete(senderId);
    const scope =
      cached?.kind === 'customer' || cached?.kind === 'customer_pets_unknown'
        ? cached
        : await this.resolveScope(senderId);
    if (scope.kind !== 'customer' && scope.kind !== 'customer_pets_unknown')
      return;
    const { customerId } = scope;
    let deleted = 0;
    let failed = 0;
    for (let round = 0; round < ERASE_ROUNDS_MAX; round += 1) {
      if (fence.expired) break;
      const listed = await this.client.listPets(customerId, 'ALL');
      if (listed.kind !== 'ok') {
        this.logger.warn(`customer pets erase stopped: ${listed.kind}`);
        break;
      }
      let progress = 0;
      for (const pet of listed.pets) {
        if (fence.expired) break;
        const outcome = await this.erasePet(customerId, pet);
        if (typeof outcome === 'object') {
          this.logger.warn(`customer pets erase stopped: ${outcome.stop}`);
          this.logErase(deleted, failed);
          return;
        }
        if (outcome === 'deleted') {
          deleted += 1;
          progress += 1;
        } else failed += 1;
      }
      if (listed.pets.length < ERASE_PAGE || progress === 0) break;
    }
    if (fence.expired)
      this.logger.warn(
        `customer pets erase stopped: past ${CUSTOMER_PETS_TASK_TIMEOUT_MS} ms`,
      );
    this.logErase(deleted, failed);
  }

  /** G3: DELETE with the version. 404 = done (also after a timeout); a
   *  conflict retries with `currentVersion`; a thrown call retries once
   *  with the same version. */
  private async erasePet(
    customerId: string,
    pet: BackendPet,
  ): Promise<EraseOutcome> {
    let version = pet.version;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: Awaited<ReturnType<CustomerPetsClient['deletePet']>>;
      try {
        result = await this.client.deletePet(customerId, pet.id, version);
      } catch (error) {
        this.warn('pet delete', error);
        continue;
      }
      switch (result.kind) {
        case 'ok':
        case 'PET_NOT_FOUND':
          return 'deleted';
        case 'PET_VERSION_CONFLICT':
          if (result.currentVersion === null) return 'failed';
          version = result.currentVersion;
          continue;
        default:
          return { stop: result.kind };
      }
    }
    return 'failed';
  }

  private logErase(deleted: number, failed: number): void {
    if (failed > 0)
      this.logger.warn(
        `customer pets erase: ${deleted} deleted, ${failed} not deleted`,
      );
    else this.logger.log(`customer pets erase: ${deleted} deleted`);
  }

  private async resolveAmbiguousNow(
    senderId: string,
    localId: string,
    backendPetId: string,
    fence: Fence,
  ): Promise<ResolveAmbiguousOutcome> {
    if (this.profiles.isForgotten(senderId)) return 'unavailable';
    if (!this.cache.has(senderId)) await this.load(senderId, false, fence);
    const state = this.cache.get(senderId);
    if (
      state === undefined ||
      state.scope.kind !== 'customer' ||
      !state.localKnown
    )
      return 'unavailable';
    const entry = state.local.find(
      (candidate) =>
        candidate.id === localId && candidate.blocked === 'ambiguous',
    );
    const body = entry === undefined ? null : localCreateBody(entry);
    if (entry === undefined || body === null) return 'not_found';
    const key = twinKey(body.name, body.species);
    const target = state.scope.pets.find(
      (pet) =>
        pet.id === backendPetId && twinKey(pet.name, pet.species) === key,
    );
    if (target === undefined) return 'not_found';
    const outcome = await this.patchBackend(
      senderId,
      state.scope.customerId,
      target,
      localPetFacts(entry, this.now()),
      fence,
      key,
    );
    if (outcome === 'forgotten') return 'unavailable';
    if (outcome === 'not_twin') return 'not_found';
    if (typeof outcome === 'object') return 'failed';
    await this.removeLocal(senderId, fence, localId);
    return 'resolved';
  }

  /* -------------------------------------------------------------- cache */

  /**
   * Replaces the sender's local list with `change(current)` (`null` = no
   * write). E1: runs on the sender's local I/O chain, so `current` is the
   * list the previous write left (never an older snapshot), and is refused
   * once the task is past its bound (F2: except a backoff update, which
   * only touches one entry of the current list). A write that lands updates
   * the cached list (it is what the store now holds). F1/F1b: a write that
   * fails or passes its bound makes the list unknown (no write until the
   * next successful read), because it may have landed.
   */
  private writeLocal(
    senderId: string,
    fence: Fence,
    change: (current: LocalPet[]) => LocalPet[] | null,
    options: { backoff?: boolean } = {},
  ): Promise<boolean> {
    return this.localStep(senderId, async () => {
      // C4: re-checked right before each write (a write would recreate the
      // profile row deleted by «olvida mis datos»).
      if (
        (fence.expired && options.backoff !== true) ||
        this.profiles.isForgotten(senderId)
      )
        return false;
      const state = this.cache.get(senderId);
      if (state === undefined || !state.localKnown) return false;
      const next = change(state.local);
      if (next === null) return false;
      const wrote = await this.storeCall('local write', () =>
        this.localStore.write(senderId, next, this.now()),
      );
      if (wrote.ok) {
        state.local = next;
        return true;
      }
      // F1b: a rejected write has an unknown outcome (e.g. the store's own
      // deadline fired while COMMIT was in flight): never write from the
      // pre-write list again; the next successful read decides.
      state.localKnown = false;
      state.loadedAt = 0;
      return false;
    });
  }

  /** F1: one local store call bounded by CUSTOMER_PETS_LOCAL_IO_TIMEOUT_MS
   *  (never rejects). A call past its bound is abandoned: its late answer
   *  (or failure) is ignored. */
  private storeCall<T>(
    operation: string,
    call: () => Promise<T>,
  ): Promise<StoreAnswer<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = Promise.resolve()
      .then(call)
      .then(
        (value): StoreAnswer<T> => ({ ok: true, value }),
        (error: unknown): StoreAnswer<T> => {
          this.warn(operation, error);
          return { ok: false, timedOut: false };
        },
      );
    const expired = new Promise<StoreAnswer<T>>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(
          `customer pets ${operation} exceeded ${CUSTOMER_PETS_LOCAL_IO_TIMEOUT_MS} ms: local pets unknown until the next read`,
        );
        resolve({ ok: false, timedOut: true });
      }, CUSTOMER_PETS_LOCAL_IO_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([answer, expired]).finally(() => clearTimeout(timer));
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

/** G4: the T4c-2 view of one known pet (only the members it has). */
function knownPet({ ref, source, view }: KnownEntry): KnownPet {
  const species =
    (view.species === undefined
      ? undefined
      : (petSpeciesWord(view.species) ?? view.species)) ??
    (view.breed === undefined ? undefined : breedSpecies(view.breed));
  const stage =
    view.stage ??
    petLifeStage(
      view.ageText,
      species === 'perro' || species === 'gato' ? species : undefined,
    );
  return {
    ref,
    ...(view.name === undefined ? {} : { name: view.name }),
    ...(species === undefined ? {} : { species }),
    ...(view.breed === undefined ? {} : { breed: view.breed }),
    ...(view.ageText === undefined ? {} : { ageLabel: view.ageText }),
    ...(stage === undefined ? {} : { stage }),
    source,
  };
}

function speciesOf(species: LocalSpecies | undefined): {
  species?: LocalSpecies;
} {
  return species === undefined ? {} : { species };
}
