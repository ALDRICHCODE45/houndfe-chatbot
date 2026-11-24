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
  type LocalPet,
  type LocalPetStore,
  type LocalSpecies,
  type PetCandidate,
} from '../domain/customer-pets';
import type { CustomerPet } from '../domain/customer-profile';
import type { PetPromptView } from '../domain/pet-facts';
import { CustomerProfileService } from './customer-profile.service';

export const CUSTOMER_PETS_CLOCK = Symbol('CUSTOMER_PETS_CLOCK');
export const CUSTOMER_PETS_ID = Symbol('CUSTOMER_PETS_ID');

/** Backend pets are reread at most this often per sender (staff edit them
 *  in the POS without a feed event); our own writes update the cache. */
export const CUSTOMER_PETS_REFRESH_MS = 60_000;

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
  loadedAt: number;
}

type Ref =
  | { kind: 'backend'; id: string }
  | { kind: 'local'; id: string }
  | { kind: 'legacy' };

type PatchOutcome = 'ok' | 'noop' | 'failed';

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
    const state = this.cache.get(senderId);
    if (
      !force &&
      state !== undefined &&
      this.now().getTime() - state.loadedAt < CUSTOMER_PETS_REFRESH_MS
    )
      return;
    try {
      let local: LocalPet[];
      try {
        local = await this.localStore.read(senderId);
      } catch (error) {
        this.warn('local read', error);
        local = state?.local ?? [];
      }
      const scope = await this.resolveScope(senderId);
      this.remember(senderId, {
        scope,
        local,
        loadedAt: this.now().getTime(),
      });
      if (scope.kind === 'customer') await this.uploadPending(senderId);
    } catch (error) {
      this.warn('prepare', error);
    }
  }

  /** After an order: the checkout may have created the Customer (S8). */
  async afterCheckout(senderId: string): Promise<void> {
    await this.prepare(senderId, true);
  }

  /**
   * Applies one statement's facts (`extractPetFacts` or rememberPetDetails)
   * to the matched pet. `legacy` is the single stored pet of the profile
   * (until T6 moves it): facts about it keep updating it like before.
   */
  async capture(
    senderId: string,
    facts: CustomerPet,
    legacy?: CustomerPet,
  ): Promise<void> {
    if (!hasPetFacts(facts) || this.profiles.isForgotten(senderId)) return;
    try {
      if (!this.cache.has(senderId)) await this.prepare(senderId);
      const state = this.cache.get(senderId);
      if (state === undefined) return;
      const { scope } = state;
      if (
        scope.kind === 'unavailable' ||
        scope.kind === 'customer_pets_unknown'
      ) {
        this.logger.log(`pet facts not stored: pets ${scope.kind}`);
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
          return await this.addLocal(senderId, state, facts);
        case 'match':
          return await this.applyTo(senderId, state, match.ref, facts);
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
    views.push(...(state?.local ?? []).map((pet) => localPetView(pet, now)));
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
    for (const pet of state.local)
      out.push({
        ref: { kind: 'local', id: pet.id },
        ...(pet.name === undefined ? {} : { name: pet.name }),
        ...speciesOf(factsSpecies(localPetFacts(pet, this.now()))),
        nameable: true,
      });
    if (legacy !== undefined && Object.keys(legacy).length > 0)
      out.push({
        ref: { kind: 'legacy' },
        ...(legacy.name === undefined ? {} : { name: legacy.name }),
        ...speciesOf(factsSpecies(legacy)),
        nameable: true,
      });
    return out;
  }

  /* ------------------------------------------------------------- writes */

  private async applyTo(
    senderId: string,
    state: SenderPets,
    ref: Ref,
    facts: CustomerPet,
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
        await this.patchBackend(senderId, state.scope.customerId, pet, facts);
      return;
    }
    const pet = state.local.find((candidate) => candidate.id === ref.id);
    if (pet === undefined) return;
    const merged = mergeFactsIntoLocal(pet, facts, this.now());
    if (merged === 'conflict') {
      this.logger.log('pet facts not stored: another species');
      return;
    }
    if (merged !== 'unchanged') {
      const next = state.local.map((entry) =>
        entry.id === pet.id ? merged : entry,
      );
      if (!(await this.writeLocal(senderId, state, next))) return;
    }
    if (state.scope.kind === 'customer') await this.uploadPending(senderId);
  }

  private async addLocal(
    senderId: string,
    state: SenderPets,
    facts: CustomerPet,
  ): Promise<void> {
    if (state.local.length >= LOCAL_PETS_MAX) {
      this.logger.warn('pet facts not stored: local pet list is full');
      return;
    }
    const pet = localPetFromFacts(this.newId(), facts, this.now());
    // Write-ahead: the entry (and its id, part of the upload key) is durable
    // before any backend create, so a retry can never duplicate the pet.
    if (!(await this.writeLocal(senderId, state, [...state.local, pet])))
      return;
    if (state.scope.kind === 'customer') await this.uploadPending(senderId);
  }

  /** Uploads every uploadable local pet of a Customer (S8). */
  private async uploadPending(senderId: string): Promise<void> {
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return;
    for (const pet of [...state.local]) await this.upload(senderId, pet.id);
  }

  private async upload(senderId: string, localId: string): Promise<void> {
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return;
    const scope = state.scope;
    const pet = state.local.find((entry) => entry.id === localId);
    if (pet === undefined || pet.upload?.blocked === true) return;
    const current = localCreateBody(pet);
    // Name and species are required by the backend: stays local until known.
    if (current === null) return;
    // The Customer already has a pet with this name (staff created it):
    // merge by PATCH instead of creating a duplicate.
    const same = scope.pets.filter(
      (candidate) =>
        foldPetName(candidate.name) === foldPetName(current.name) &&
        candidate.species === current.species,
    );
    if (pet.upload === undefined && same.length === 1) {
      const outcome = await this.patchBackend(
        senderId,
        scope.customerId,
        same[0],
        localPetFacts(pet, this.now()),
      );
      if (outcome !== 'failed') await this.removeLocal(senderId, localId);
      return;
    }
    // A retry under the same key must send the first attempt's bytes.
    let body = current;
    if (pet.upload?.customerId === scope.customerId) body = pet.upload.body;
    else {
      const frozen: LocalPet = {
        ...pet,
        upload: { customerId: scope.customerId, body },
      };
      const next = state.local.map((entry) =>
        entry.id === localId ? frozen : entry,
      );
      if (!(await this.writeLocal(senderId, state, next))) return;
    }
    const key = localPetUploadKey(scope.customerId, localId);
    let result: Awaited<ReturnType<CustomerPetsClient['createPet']>>;
    try {
      result = await this.client.createPet(scope.customerId, body, key);
    } catch (error) {
      this.warn('pet create', error);
      return;
    }
    switch (result.kind) {
      case 'ok': {
        this.upsertBackend(senderId, result.pet);
        await this.removeLocal(senderId, localId);
        // Facts learned after the first (uncertain) attempt: patch them.
        if (JSON.stringify(current) !== JSON.stringify(body))
          await this.patchBackend(
            senderId,
            scope.customerId,
            result.pet,
            localPetFacts(pet, this.now()),
          );
        return;
      }
      case 'PET_LIMIT_REACHED':
        this.logger.warn('pet create refused: PET_LIMIT_REACHED (not stored)');
        await this.removeLocal(senderId, localId);
        return;
      case 'IDEMPOTENCY_KEY_CONFLICT': {
        this.logger.warn(
          'pet create refused: IDEMPOTENCY_KEY_CONFLICT (kept local)',
        );
        const latest = this.cache.get(senderId);
        if (latest === undefined) return;
        await this.writeLocal(
          senderId,
          latest,
          latest.local.map((entry) =>
            entry.id === localId && entry.upload !== undefined
              ? { ...entry, upload: { ...entry.upload, blocked: true } }
              : entry,
          ),
        );
        return;
      }
      default:
        this.logger.warn(`pet create not done: ${result.kind} (kept local)`);
    }
  }

  /**
   * C1: PATCH only the changed fields. On `PET_VERSION_CONFLICT` reread
   * (`?status=ALL`), accept when the values already match, else retry once
   * with the current version.
   */
  private async patchBackend(
    senderId: string,
    customerId: string,
    pet: BackendPet,
    facts: CustomerPet,
  ): Promise<PatchOutcome> {
    let target = pet;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const diff = backendPetPatch(target, facts);
      if (diff === 'conflict') {
        this.logger.log('pet facts not stored: another species');
        return 'failed';
      }
      if (diff === null) return attempt === 0 ? 'noop' : 'ok';
      let result: Awaited<ReturnType<CustomerPetsClient['patchPet']>>;
      try {
        result = await this.client.patchPet(customerId, target.id, {
          version: target.version,
          ...diff,
        });
      } catch (error) {
        this.warn('pet patch', error);
        return 'failed';
      }
      if (result.kind === 'ok') {
        this.upsertBackend(senderId, result.pet);
        return 'ok';
      }
      if (result.kind !== 'PET_VERSION_CONFLICT' || attempt > 0) {
        this.logger.warn(`pet patch not done: ${result.kind}`);
        if (result.kind === 'PET_ARCHIVED' || result.kind === 'PET_NOT_FOUND')
          this.dropBackend(senderId, target.id);
        return 'failed';
      }
      const fresh = await this.reread(customerId, target.id);
      if (fresh === null || fresh.status !== 'ACTIVE') {
        this.dropBackend(senderId, target.id);
        return 'failed';
      }
      this.upsertBackend(senderId, fresh);
      target = fresh;
    }
    return 'failed';
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

  private async writeLocal(
    senderId: string,
    state: SenderPets,
    next: LocalPet[],
  ): Promise<boolean> {
    try {
      await this.localStore.write(senderId, next, this.now());
      state.local = next;
      return true;
    } catch (error) {
      this.warn('local write', error);
      return false;
    }
  }

  /** Removed only after a backend success; a failed write keeps the entry
   *  for a retry (same key, same body → replay). */
  private async removeLocal(senderId: string, localId: string): Promise<void> {
    const state = this.cache.get(senderId);
    if (state === undefined) return;
    await this.writeLocal(
      senderId,
      state,
      state.local.filter((entry) => entry.id !== localId),
    );
  }

  /** Our write's answer replaces the cached pet (same position); a new pet
   *  goes last; a non-ACTIVE one leaves the list. */
  private upsertBackend(senderId: string, pet: BackendPet): void {
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

  private dropBackend(senderId: string, petId: string): void {
    const state = this.cache.get(senderId);
    if (state === undefined || state.scope.kind !== 'customer') return;
    state.scope.pets = state.scope.pets.filter((entry) => entry.id !== petId);
  }

  private remember(senderId: string, state: SenderPets): void {
    this.cache.delete(senderId);
    this.cache.set(senderId, state);
    if (this.cache.size > CACHE_MAX) {
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
  }

  private warn(operation: string, error: unknown): void {
    this.logger.warn(
      `customer pets ${operation} failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}

function backendSpecies(pet: BackendPet): LocalSpecies | 'otro' {
  return pet.species === 'DOG'
    ? 'perro'
    : pet.species === 'CAT'
      ? 'gato'
      : 'otro';
}

function speciesOf(species: LocalSpecies | undefined): {
  species?: LocalSpecies;
} {
  return species === undefined ? {} : { species };
}
