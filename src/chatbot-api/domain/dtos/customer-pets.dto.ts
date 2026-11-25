import { z } from 'zod';

/**
 * Customer pets, bot side of docs/contracts/customer-pets-bot-contract.md
 * (backend T2). Pets live in the backend (Customer → pets); the bot reads
 * them on every turn and writes through `/chatbot-api/customers/:id/pets`.
 * Responses are tolerant reads: wrong types, enums and missing keys fail
 * closed, unknown keys are stripped (the backend adds fields over time).
 */

export const PET_SPECIES = ['DOG', 'CAT', 'OTHER'] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];
export const PET_SIZES = ['SMALL', 'MEDIUM', 'LARGE', 'GIANT'] as const;
export type PetSize = (typeof PET_SIZES)[number];
export const PET_BIRTH_DATE_PRECISIONS = ['EXACT', 'MONTH', 'YEAR'] as const;
export type PetBirthDatePrecision = (typeof PET_BIRTH_DATE_PRECISIONS)[number];
export const PET_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type PetStatus = (typeof PET_STATUSES)[number];
/** `?status=` of the list route; the backend defaults to `ACTIVE`. */
export type PetListStatus = PetStatus | 'ALL';

/** The only warning the backend emits today (§1); never an error. */
export const PET_NAME_DUPLICATE = 'PET_NAME_DUPLICATE';

const text = z.string().nullable();

/** §2: the pet shape shared by every route. */
export const customerPetSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  name: z.string().min(1),
  species: z.enum(PET_SPECIES),
  speciesOther: text,
  breed: text,
  size: z.enum(PET_SIZES).nullable(),
  birthDate: text,
  birthDatePrecision: z.enum(PET_BIRTH_DATE_PRECISIONS).nullable(),
  /** Derived at read time (§3), `null` without `birthDate`. */
  ageMonths: z.number().int().min(0).nullable(),
  /** «~10 meses», «3 años», «menos de 1 mes»; `null` without `birthDate`. */
  ageLabel: text,
  /** Warning only: the catalog has no ingredients. */
  allergies: text,
  notes: text,
  status: z.enum(PET_STATUSES),
  archivedAt: text,
  archivedReason: text,
  /** `CHATBOT` or `POS`; informational. */
  createdVia: z.string().min(1),
  version: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type CustomerPet = z.infer<typeof customerPetSchema>;

export const customerPetListSchema = z.array(customerPetSchema);

/** Every write answers the complete pet plus `warnings` (empty when none). */
const petWriteSchema = customerPetSchema.extend({
  warnings: z.array(z.string()),
});

/** `GET …/pets` and `customer.pets` of by-phone; null on contract breaks. */
export function parseCustomerPetList(body: unknown): CustomerPet[] | null {
  const parsed = customerPetListSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** A write response split into the pet and its warnings; null when invalid. */
export function parseCustomerPetWrite(
  body: unknown,
): { pet: CustomerPet; warnings: string[] } | null {
  const parsed = petWriteSchema.safeParse(body);
  if (!parsed.success) return null;
  const { warnings, ...pet } = parsed.data;
  return { pet, warnings };
}

/* ------------------------------------------------------------------ input */

/** §3: send either an exact/approximate date or an approximate age. */
export interface PetApproxAge {
  years?: number;
  months?: number;
}

/** §4.1 create body. `name` and `species` required; `null` = absent. */
export interface CreatePetInput {
  name: string;
  species: PetSpecies;
  speciesOther?: string | null;
  breed?: string | null;
  size?: PetSize | null;
  birthDate?: string | null;
  birthDatePrecision?: PetBirthDatePrecision | null;
  approxAge?: PetApproxAge | null;
  allergies?: string | null;
  notes?: string | null;
}

/**
 * §4.2 PATCH body. Absent = unchanged, `null` clears (never on `name` or
 * `species`). The bot never sends fields it does not change (agreement C1).
 */
export interface PatchPetInput {
  version: number;
  name?: string;
  species?: PetSpecies;
  speciesOther?: string | null;
  breed?: string | null;
  size?: PetSize | null;
  birthDate?: string | null;
  birthDatePrecision?: PetBirthDatePrecision | null;
  approxAge?: PetApproxAge | null;
  allergies?: string | null;
  notes?: string | null;
}

export interface ArchivePetInput {
  version: number;
  /** ≤ 280; blank is stored as `null`. */
  reason?: string | null;
}

export interface RestorePetInput {
  version: number;
}

const PET_BODY_KEYS = [
  'name',
  'species',
  'speciesOther',
  'breed',
  'size',
  'birthDate',
  'birthDatePrecision',
  'approxAge',
  'allergies',
  'notes',
] as const;

/**
 * The wire body: only the documented members, in a fixed order, without
 * `undefined` ones. The backend rejects unknown members, and a fixed shape
 * keeps a create retry byte-identical under the same idempotency key.
 *
 * T4b (L13 a): `null` means absent on create, so a create drops it like
 * `undefined` (a null/undefined flip never changes the bytes under the same
 * key); a PATCH keeps `null` because it clears. An `approxAge` without whole
 * `years`/`months` is never sent (the backend needs at least one).
 */
export function toPetBody(
  input: CreatePetInput | PatchPetInput,
  leading: Record<string, unknown> = {},
  mode: 'create' | 'patch' = 'patch',
): Record<string, unknown> {
  const source = input as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = { ...leading };
  for (const key of PET_BODY_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (value === null && mode === 'create') continue;
    if (key === 'approxAge' && value !== null && typeof value === 'object') {
      const age = value as PetApproxAge;
      const approxAge = {
        ...(typeof age.years === 'number' ? { years: age.years } : {}),
        ...(typeof age.months === 'number' ? { months: age.months } : {}),
      };
      if (Object.keys(approxAge).length === 0) continue;
      body[key] = approxAge;
      continue;
    }
    body[key] = value;
  }
  return body;
}

/** `version` is an integer ≥ 1 (§4.2–§4.5). */
export function isPetVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** Backend: key per sucursal, 1–200 characters after trimming (§4.1). */
export const PET_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/* ---------------------------------------------------------------- results */

export type PetForbidden = { kind: 'FORBIDDEN' };
export type PetCustomerNotFound = { kind: 'CUSTOMER_NOT_FOUND' };
export type PetNotFound = { kind: 'PET_NOT_FOUND' };
/** Stale `version`: reread (`GET …?status=ALL`, find by id) and decide. */
export type PetVersionConflict = {
  kind: 'PET_VERSION_CONFLICT';
  /** `currentVersion` at the error root; `null` when the body lacks it. */
  currentVersion: number | null;
};
export type PetWriteOk = {
  kind: 'ok';
  pet: CustomerPet;
  /** e.g. `["PET_NAME_DUPLICATE"]`; empty when none. */
  warnings: string[];
};

export type ListPetsResult =
  | { kind: 'ok'; pets: CustomerPet[] }
  | PetCustomerNotFound
  | PetForbidden;

export type CreatePetResult =
  | (PetWriteOk & {
      /** `true` for 201, `false` for the 200 replay (same key + same body:
       *  the FIRST response byte for byte; reread for the current state). */
      created: boolean;
    })
  | PetCustomerNotFound
  | { kind: 'PET_LIMIT_REACHED' }
  /** Same key, different body: the key is spent for this pet. */
  | { kind: 'IDEMPOTENCY_KEY_CONFLICT' }
  /** The first request is still running: retry shortly, same key + body. */
  | { kind: 'IDEMPOTENCY_KEY_IN_FLIGHT' }
  | { kind: 'INVALID_IDEMPOTENCY_KEY' }
  | PetForbidden;

export type PatchPetResult =
  | PetWriteOk
  | PetCustomerNotFound
  | PetNotFound
  | PetVersionConflict
  | { kind: 'PET_ARCHIVED' }
  | PetForbidden;

export type ArchivePetResult = PatchPetResult;

export type RestorePetResult =
  | PetWriteOk
  | PetCustomerNotFound
  | PetNotFound
  | PetVersionConflict
  | { kind: 'PET_NOT_ARCHIVED' }
  | { kind: 'PET_LIMIT_REACHED' }
  | PetForbidden;

export type DeletePetResult =
  | { kind: 'ok' }
  | PetCustomerNotFound
  /** On a retry after a timeout this means done (§4.5). */
  | PetNotFound
  | PetVersionConflict
  | PetForbidden;
