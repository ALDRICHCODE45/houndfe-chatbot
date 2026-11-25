import type {
  ArchivePetInput,
  ArchivePetResult,
  CreatePetInput,
  CreatePetResult,
  DeletePetResult,
  ListPetsResult,
  PatchPetInput,
  PatchPetResult,
  PetListStatus,
  RestorePetInput,
  RestorePetResult,
} from './dtos/customer-pets.dto';

export const CUSTOMER_PETS_CLIENT = Symbol('CUSTOMER_PETS_CLIENT');

/**
 * Customer pets (docs/contracts/customer-pets-bot-contract.md §4), a separate
 * port so existing `ChatbotApiClient` fakes stay valid. Implemented by the
 * same HTTP adapter. Documented answers (§9 codes and `403` missing scope)
 * resolve as typed results discriminated by `kind`; everything else (401,
 * 400 validation, 429, 5xx, timeouts, an undocumented 404, malformed bodies)
 * rejects with `ChatbotApiError` subclasses as everywhere else.
 *
 * Only the list is retried (safe GET policy). Writes are single attempt: a
 * timeout is an unknown outcome. Retry a create with the SAME key and the
 * SAME body (a `200` replay is success); retry PATCH/archive/restore/DELETE
 * with the same `version` and, on `PET_VERSION_CONFLICT`, reread and compare.
 */
export interface CustomerPetsClient {
  /** `GET /chatbot-api/customers/:customerId/pets[?status=]` (scope
   *  `pets:read`). Without `status` the backend answers ACTIVE pets. */
  listPets(customerId: string, status?: PetListStatus): Promise<ListPetsResult>;
  /** `POST …/pets` (scope `pets:write`) with `X-Idempotency-Key`. */
  createPet(
    customerId: string,
    input: CreatePetInput,
    idempotencyKey: string,
  ): Promise<CreatePetResult>;
  /** `PATCH …/pets/:petId` (scope `pets:write`), `version` in the body. */
  patchPet(
    customerId: string,
    petId: string,
    input: PatchPetInput,
  ): Promise<PatchPetResult>;
  /** `POST …/pets/:petId/archive` (scope `pets:write`): «ya no está». */
  archivePet(
    customerId: string,
    petId: string,
    input: ArchivePetInput,
  ): Promise<ArchivePetResult>;
  /** `POST …/pets/:petId/restore` (scope `pets:write`). */
  restorePet(
    customerId: string,
    petId: string,
    input: RestorePetInput,
  ): Promise<RestorePetResult>;
  /** `DELETE …/pets/:petId?version=N` (scope `pets:delete`), no body, `204`.
   *  Only for an explicit «olvida mis datos». */
  deletePet(
    customerId: string,
    petId: string,
    version: number,
  ): Promise<DeletePetResult>;
}
