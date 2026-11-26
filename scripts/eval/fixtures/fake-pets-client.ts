import type { ChatbotApiClient } from '../../../src/chatbot-api/domain/chatbot-api.client';
import type { CustomerPetsClient } from '../../../src/chatbot-api/domain/customer-pets.port';
import {
  PET_IDEMPOTENCY_KEY_MAX_LENGTH,
  PET_NAME_DUPLICATE,
  toPetBody,
  type ArchivePetInput,
  type ArchivePetResult,
  type CreatePetInput,
  type CreatePetResult,
  type CustomerPet,
  type DeletePetResult,
  type ListPetsResult,
  type PatchPetInput,
  type PatchPetResult,
  type PetBirthDatePrecision,
  type PetListStatus,
  type RestorePetInput,
  type RestorePetResult,
} from '../../../src/chatbot-api/domain/dtos/customer-pets.dto';
import type { CustomerLookupResponse } from '../../../src/chatbot-api/domain/dtos/customers.dto';
import type { ApiEvent, FixtureCustomer } from './fake-api';
import { EVAL_CUSTOMER_ID } from './fake-api';

/** A pet the backend already holds when the scenario starts (staff, POS). */
export type EvalPetSeed = Pick<
  CustomerPet,
  'id' | 'name' | 'species' | 'breed' | 'size'
> & {
  birthDate: string | null;
  birthDatePrecision: PetBirthDatePrecision | null;
  allergies?: string | null;
  notes?: string | null;
};

/** Max, a 3-year-old labrador (the owner's example, S3). */
export const EVAL_PET_MAX: EvalPetSeed = {
  id: 'f0000000-0000-4000-8000-000000000001',
  name: 'Max',
  species: 'DOG',
  breed: 'Labrador',
  size: 'LARGE',
  birthDate: '2023-01-01',
  birthDatePrecision: 'YEAR',
};

/** Bruno, a chihuahua born in January 2026 (~10 months in November 2026). */
export const EVAL_PET_BRUNO: EvalPetSeed = {
  id: 'f0000000-0000-4000-8000-000000000002',
  name: 'Bruno',
  species: 'DOG',
  breed: 'Chihuahua',
  size: 'SMALL',
  birthDate: '2026-01-01',
  birthDatePrecision: 'MONTH',
};

/** Contract §1: at most 20 ACTIVE pets per customer. */
const ACTIVE_LIMIT = 20;
/** Contract §1: `?status=ARCHIVED|ALL` is capped at 100 rows. */
const LIST_CAP = 100;

/** Case, accents and repeated spaces ignored (contract §1 duplicates). */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Contract §1: text is trimmed, blank is stored as `null`. */
const clean = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Contract §3: the stored birth date for an exact/approximate input. */
function storedBirth(
  input: Pick<CreatePetInput, 'birthDate' | 'birthDatePrecision' | 'approxAge'>,
  now: Date,
): { birthDate: string; birthDatePrecision: PetBirthDatePrecision } | null {
  const age = input.approxAge;
  if (age !== undefined && age !== null) {
    if (typeof age.months === 'number') {
      const months = (age.years ?? 0) * 12 + age.months;
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1),
      );
      return { birthDate: isoDay(date), birthDatePrecision: 'MONTH' };
    }
    if (typeof age.years === 'number')
      return {
        birthDate: `${now.getUTCFullYear() - age.years}-01-01`,
        birthDatePrecision: 'YEAR',
      };
    return null;
  }
  if (typeof input.birthDate !== 'string' || !input.birthDatePrecision)
    return null;
  const [year, month] = input.birthDate.split('-');
  const birthDate =
    input.birthDatePrecision === 'YEAR'
      ? `${year}-01-01`
      : input.birthDatePrecision === 'MONTH'
        ? `${year}-${month}-01`
        : input.birthDate;
  return { birthDate, birthDatePrecision: input.birthDatePrecision };
}

/** Contract §3: `ageMonths` / `ageLabel` derived at read time. */
function ageOf(
  birthDate: string | null,
  precision: PetBirthDatePrecision | null,
  now: Date,
): { ageMonths: number | null; ageLabel: string | null } {
  if (birthDate === null || precision === null)
    return { ageMonths: null, ageLabel: null };
  const [y, m, d] = birthDate.split('-').map(Number);
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  if (now.getUTCDate() < d) months -= 1;
  months = Math.max(0, months);
  if (months === 0) return { ageMonths: 0, ageLabel: 'menos de 1 mes' };
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const unit = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const label =
    years === 0
      ? unit(months, 'mes', 'meses')
      : rest === 0 || precision === 'YEAR'
        ? unit(years, 'año', 'años')
        : `${unit(years, 'año', 'años')} ${unit(rest, 'mes', 'meses')}`;
  return {
    ageMonths: months,
    ageLabel: precision === 'EXACT' ? label : `~${label}`,
  };
}

/** Short `key "value"` list of the members a write sent, for the transcript. */
function describeBody(body: Record<string, unknown>): string {
  return Object.entries(body)
    .filter(([key]) => key !== 'version')
    .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
    .join(', ');
}

/**
 * In-memory `CustomerPetsClient` for the conversation eval: the backend's
 * pets (docs/contracts/customer-pets-bot-contract.md §1–§4, §9) with
 * per-customer state, `version` +1 on every write, idempotent create
 * (same key + same body → the first response, `created: false`; another
 * body → `IDEMPOTENCY_KEY_CONFLICT`), `PET_VERSION_CONFLICT` with
 * `currentVersion`, `PET_ARCHIVED`, `PET_NOT_ARCHIVED`, `PET_NOT_FOUND`,
 * `CUSTOMER_NOT_FOUND` and the 20-active limit. Every call adds one line to
 * `events` (the transcript's backend activity).
 */
export class EvalFakePetsClient implements CustomerPetsClient {
  private readonly pets = new Map<string, CustomerPet>();
  private readonly customers = new Set<string>();
  private readonly receipts = new Map<
    string,
    { body: string; response: CreatePetResult }
  >();
  private seq = 0;
  private readonly now: () => Date;
  readonly events: ApiEvent[];

  constructor(options: { events?: ApiEvent[]; now?: () => Date } = {}) {
    this.events = options.events ?? [];
    this.now = options.now ?? (() => new Date());
  }

  /** Registers a backend customer with the pets staff already entered. */
  addCustomer(customerId: string, seeds: readonly EvalPetSeed[] = []): void {
    this.customers.add(customerId);
    const at = '2026-10-01T10:00:00.000Z';
    for (const seed of seeds) {
      if (this.pets.has(seed.id)) continue;
      this.pets.set(seed.id, {
        id: seed.id,
        customerId,
        name: seed.name,
        species: seed.species,
        speciesOther: null,
        breed: seed.breed,
        size: seed.size,
        birthDate: seed.birthDate,
        birthDatePrecision: seed.birthDatePrecision,
        ageMonths: null,
        ageLabel: null,
        allergies: seed.allergies ?? null,
        notes: seed.notes ?? null,
        status: 'ACTIVE',
        archivedAt: null,
        archivedReason: null,
        createdVia: 'POS',
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  hasCustomer(customerId: string): boolean {
    return this.customers.has(customerId);
  }

  /** Every pet of the customer as the backend holds it now (test reads). */
  all(customerId: string): CustomerPet[] {
    return [...this.pets.values()]
      .filter((pet) => pet.customerId === customerId)
      .map((pet) => this.view(pet));
  }

  /** Contract §2: ACTIVE pets sorted by name (`customer.pets` of by-phone). */
  activePets(customerId: string): CustomerPet[] {
    return this.sorted(customerId, 'ACTIVE');
  }

  listPets(
    customerId: string,
    status: PetListStatus = 'ACTIVE',
  ): Promise<ListPetsResult> {
    if (!this.customers.has(customerId)) {
      this.events.push(`listPets(${status}) → CUSTOMER_NOT_FOUND`);
      return Promise.resolve({ kind: 'CUSTOMER_NOT_FOUND' });
    }
    const pets = this.sorted(customerId, status);
    this.events.push(`listPets(${status}) → ${pets.length} pet(s)`);
    return Promise.resolve({ kind: 'ok', pets });
  }

  createPet(
    customerId: string,
    input: CreatePetInput,
    idempotencyKey: string,
  ): Promise<CreatePetResult> {
    const body = toPetBody(input, {}, 'create');
    const label = `createPet(${describeBody(body)})`;
    const answer = (result: CreatePetResult, note: string) => {
      this.events.push(`${label} → ${note}`);
      return Promise.resolve(structuredClone(result));
    };
    const key = idempotencyKey.trim();
    if (key === '' || key.length > PET_IDEMPOTENCY_KEY_MAX_LENGTH)
      return answer(
        { kind: 'INVALID_IDEMPOTENCY_KEY' },
        'INVALID_IDEMPOTENCY_KEY',
      );
    // §4.1: the comparison includes the path customerId.
    const fingerprint = JSON.stringify({ customerId, ...body });
    const receipt = this.receipts.get(key);
    if (receipt !== undefined) {
      if (receipt.body !== fingerprint)
        return answer(
          { kind: 'IDEMPOTENCY_KEY_CONFLICT' },
          'IDEMPOTENCY_KEY_CONFLICT',
        );
      return answer(
        { ...receipt.response, created: false } as CreatePetResult,
        'replay (200)',
      );
    }
    if (!this.customers.has(customerId))
      return answer({ kind: 'CUSTOMER_NOT_FOUND' }, 'CUSTOMER_NOT_FOUND');
    if (this.activePets(customerId).length >= ACTIVE_LIMIT)
      return answer({ kind: 'PET_LIMIT_REACHED' }, 'PET_LIMIT_REACHED');
    const at = this.now().toISOString();
    const birth = storedBirth(input, this.now());
    const id = `f1000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
    const pet: CustomerPet = {
      id,
      customerId,
      name: input.name.trim(),
      species: input.species,
      speciesOther:
        input.species === 'OTHER' ? clean(input.speciesOther) : null,
      breed: clean(input.breed),
      size: input.size ?? null,
      birthDate: birth?.birthDate ?? null,
      birthDatePrecision: birth?.birthDatePrecision ?? null,
      ageMonths: null,
      ageLabel: null,
      allergies: clean(input.allergies),
      notes: clean(input.notes),
      status: 'ACTIVE',
      archivedAt: null,
      archivedReason: null,
      createdVia: 'CHATBOT',
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    const warnings = this.duplicateWarning(pet);
    this.pets.set(id, pet);
    const response: CreatePetResult = {
      kind: 'ok',
      pet: this.view(pet),
      warnings,
      created: true,
    };
    this.receipts.set(key, {
      body: fingerprint,
      response: structuredClone(response),
    });
    return answer(response, `created ${pet.name} v1`);
  }

  patchPet(
    customerId: string,
    petId: string,
    input: PatchPetInput,
  ): Promise<PatchPetResult> {
    const body = toPetBody(input, {}, 'patch');
    return this.write<PatchPetResult>(
      'patchPet',
      customerId,
      petId,
      input.version,
      describeBody(body),
      (pet) => {
        if (pet.status === 'ARCHIVED') return { kind: 'PET_ARCHIVED' };
        const nameChanged =
          input.name !== undefined && fold(input.name) !== fold(pet.name);
        const next: CustomerPet = { ...pet };
        if (input.name !== undefined) next.name = input.name.trim();
        if (input.species !== undefined) {
          next.species = input.species;
          if (input.species !== 'OTHER') next.speciesOther = null;
        }
        if (input.speciesOther !== undefined)
          next.speciesOther = clean(input.speciesOther);
        if (input.breed !== undefined) next.breed = clean(input.breed);
        if (input.size !== undefined) next.size = input.size;
        if (input.allergies !== undefined)
          next.allergies = clean(input.allergies);
        if (input.notes !== undefined) next.notes = clean(input.notes);
        if (input.birthDate === null) {
          next.birthDate = null;
          next.birthDatePrecision = null;
        } else {
          const birth = storedBirth(input, this.now());
          if (birth !== null) {
            next.birthDate = birth.birthDate;
            next.birthDatePrecision = birth.birthDatePrecision;
          }
        }
        return {
          pet: next,
          warnings: nameChanged ? this.duplicateWarning(next) : [],
        };
      },
    );
  }

  archivePet(
    customerId: string,
    petId: string,
    input: ArchivePetInput,
  ): Promise<ArchivePetResult> {
    return this.write<ArchivePetResult>(
      'archivePet',
      customerId,
      petId,
      input.version,
      `reason ${JSON.stringify(input.reason ?? null)}`,
      (pet) => {
        if (pet.status === 'ARCHIVED') return { kind: 'PET_ARCHIVED' };
        return {
          pet: {
            ...pet,
            status: 'ARCHIVED',
            archivedAt: this.now().toISOString(),
            archivedReason: clean(input.reason),
          },
          warnings: [],
        };
      },
    );
  }

  restorePet(
    customerId: string,
    petId: string,
    input: RestorePetInput,
  ): Promise<RestorePetResult> {
    return this.write<RestorePetResult>(
      'restorePet',
      customerId,
      petId,
      input.version,
      '',
      (pet) => {
        if (pet.status === 'ACTIVE') return { kind: 'PET_NOT_ARCHIVED' };
        if (this.activePets(customerId).length >= ACTIVE_LIMIT)
          return { kind: 'PET_LIMIT_REACHED' };
        const next: CustomerPet = {
          ...pet,
          status: 'ACTIVE',
          archivedAt: null,
          archivedReason: null,
        };
        return { pet: next, warnings: this.duplicateWarning(next) };
      },
    );
  }

  deletePet(
    customerId: string,
    petId: string,
    version: number,
  ): Promise<DeletePetResult> {
    const pet = this.pets.get(petId);
    const label = `deletePet(${pet?.name ?? petId} v${version})`;
    const answer = (result: DeletePetResult, note: string) => {
      this.events.push(`${label} → ${note}`);
      return Promise.resolve(result);
    };
    if (!this.customers.has(customerId))
      return answer({ kind: 'CUSTOMER_NOT_FOUND' }, 'CUSTOMER_NOT_FOUND');
    if (pet === undefined || pet.customerId !== customerId)
      return answer({ kind: 'PET_NOT_FOUND' }, 'PET_NOT_FOUND');
    if (pet.version !== version)
      return answer(
        { kind: 'PET_VERSION_CONFLICT', currentVersion: pet.version },
        `PET_VERSION_CONFLICT (current v${pet.version})`,
      );
    this.pets.delete(petId);
    return answer({ kind: 'ok' }, 'deleted (204)');
  }

  /**
   * PATCH/archive/restore: §4.2 check order (customer, pet exists, version,
   * state), then the change with `version` +1 and a new `updatedAt`.
   */
  private write<R extends PatchPetResult | RestorePetResult>(
    method: string,
    customerId: string,
    petId: string,
    version: number,
    detail: string,
    change: (
      pet: CustomerPet,
    ) => { pet: CustomerPet; warnings: string[] } | Exclude<R, { kind: 'ok' }>,
  ): Promise<R> {
    const current = this.pets.get(petId);
    const label = `${method}(${current?.name ?? petId} v${version}${detail === '' ? '' : ` ${detail}`})`;
    const answer = (result: R, note: string) => {
      this.events.push(`${label} → ${note}`);
      return Promise.resolve(structuredClone(result));
    };
    if (!this.customers.has(customerId))
      return answer({ kind: 'CUSTOMER_NOT_FOUND' } as R, 'CUSTOMER_NOT_FOUND');
    if (current === undefined || current.customerId !== customerId)
      return answer({ kind: 'PET_NOT_FOUND' } as R, 'PET_NOT_FOUND');
    if (current.version !== version)
      return answer(
        { kind: 'PET_VERSION_CONFLICT', currentVersion: current.version } as R,
        `PET_VERSION_CONFLICT (current v${current.version})`,
      );
    const outcome = change(current);
    if ('kind' in outcome) return answer(outcome, outcome.kind);
    const next: CustomerPet = {
      ...outcome.pet,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.pets.set(petId, next);
    return answer(
      { kind: 'ok', pet: this.view(next), warnings: outcome.warnings } as R,
      `${next.status} v${next.version}`,
    );
  }

  /** `PET_NAME_DUPLICATE` when another ACTIVE pet has the same folded name. */
  private duplicateWarning(pet: CustomerPet): string[] {
    const twin = [...this.pets.values()].some(
      (other) =>
        other.id !== pet.id &&
        other.customerId === pet.customerId &&
        other.status === 'ACTIVE' &&
        fold(other.name) === fold(pet.name),
    );
    return twin ? [PET_NAME_DUPLICATE] : [];
  }

  /** Contract §2 orders: ACTIVE by name, ARCHIVED by archivedAt desc, ALL newest first. */
  private sorted(customerId: string, status: PetListStatus): CustomerPet[] {
    const own = [...this.pets.values()].filter(
      (pet) =>
        pet.customerId === customerId &&
        (status === 'ALL' || pet.status === status),
    );
    const byCreation = (a: CustomerPet, b: CustomerPet) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    if (status === 'ACTIVE')
      own.sort(
        (a, b) => fold(a.name).localeCompare(fold(b.name)) || byCreation(a, b),
      );
    else if (status === 'ARCHIVED')
      own.sort((a, b) =>
        (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''),
      );
    else own.sort((a, b) => byCreation(b, a));
    return (status === 'ACTIVE' ? own : own.slice(0, LIST_CAP)).map((pet) =>
      this.view(pet),
    );
  }

  /** A copy with the age fields computed now (§3). */
  private view(pet: CustomerPet): CustomerPet {
    return {
      ...structuredClone(pet),
      ...ageOf(pet.birthDate, pet.birthDatePrecision, this.now()),
    };
  }
}

/**
 * The eval's `GET customers/by-phone` for the pet store: an existing fixture
 * customer is found with its ACTIVE pets (credential with `pets:read`); a new
 * one is a prospect until a checkout of this scenario creates the Customer,
 * then it is found (its local pets upload, S8).
 */
export function evalCustomerLookup(
  customer: FixtureCustomer,
  pets: EvalFakePetsClient,
  orders: ReadonlyMap<string, { customer: { firstName: string } }>,
): Pick<ChatbotApiClient, 'getCustomerByPhone'> {
  if (customer.kind === 'existing')
    pets.addCustomer(EVAL_CUSTOMER_ID, customer.pets ?? []);
  return {
    getCustomerByPhone: (cc: string, phone: string) => {
      const created = [...orders.values()][0];
      const firstName =
        customer.kind === 'existing'
          ? customer.firstName
          : created?.customer.firstName;
      if (firstName === undefined) {
        const none: CustomerLookupResponse = { found: false, customer: null };
        return Promise.resolve(none);
      }
      if (!pets.hasCustomer(EVAL_CUSTOMER_ID))
        pets.addCustomer(EVAL_CUSTOMER_ID);
      const found: CustomerLookupResponse = {
        found: true,
        customer: {
          customerId: EVAL_CUSTOMER_ID,
          firstName,
          lastName: null,
          phoneCountryCode: cc,
          phone,
          preferredPaymentMethod: null,
          address: null,
          pets: pets.activePets(EVAL_CUSTOMER_ID),
        },
      };
      return Promise.resolve(found);
    },
  };
}
