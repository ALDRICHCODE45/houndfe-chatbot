import { normalizeLocalPets, type LocalPet } from '../domain/customer-pets';
import {
  isEmptyProfilePatch,
  isValidProfileSenderId,
  mergeCustomerProfile,
  normalizeCustomerProfilePatch,
  type CustomerProfile,
  type CustomerProfilePatch,
  type CustomerProfileStore,
} from '../domain/customer-profile';

/**
 * In-memory CustomerProfileStore for tests and the conversation eval. A
 * fresh instance forgets everything; share one instance to simulate a
 * restart that keeps the database.
 */
export class InMemoryCustomerProfileStore implements CustomerProfileStore {
  private readonly profiles = new Map<string, CustomerProfile>();
  /** T4b: the `pets` column of the same rows (see InMemoryLocalPetStore). */
  private readonly localPets = new Map<string, LocalPet[]>();

  read(senderId: string): Promise<CustomerProfile | null> {
    const profile = this.profiles.get(senderId);
    return Promise.resolve(
      profile === undefined ? null : structuredClone(profile),
    );
  }

  upsert(
    senderId: string,
    patch: CustomerProfilePatch,
    now: Date,
  ): Promise<CustomerProfile | null> {
    if (!isValidProfileSenderId(senderId)) return Promise.resolve(null);
    const existing = this.profiles.get(senderId) ?? null;
    if (
      existing === null &&
      isEmptyProfilePatch(normalizeCustomerProfilePatch(patch))
    )
      return Promise.resolve(null);
    const merged = mergeCustomerProfile(senderId, existing, patch, now);
    this.profiles.set(senderId, merged);
    return Promise.resolve(structuredClone(merged));
  }

  delete(senderId: string): Promise<boolean> {
    this.localPets.delete(senderId);
    return Promise.resolve(this.profiles.delete(senderId));
  }

  clearPet(senderId: string, now: Date): Promise<boolean> {
    const profile = this.profiles.get(senderId);
    if (profile?.pet === undefined) return Promise.resolve(false);
    const next = { ...profile, updatedAt: now.toISOString() };
    delete next.pet;
    this.profiles.set(senderId, next);
    return Promise.resolve(true);
  }

  readLocalPets(senderId: string): LocalPet[] {
    if (!this.profiles.has(senderId)) return [];
    return normalizeLocalPets(
      structuredClone(this.localPets.get(senderId) ?? []),
    );
  }

  /** Replace semantics; an empty list never creates a profile row. */
  writeLocalPets(senderId: string, pets: LocalPet[], now: Date): void {
    if (!isValidProfileSenderId(senderId)) return;
    const existing = this.profiles.get(senderId) ?? null;
    if (pets.length === 0) {
      this.localPets.delete(senderId);
      return;
    }
    if (existing === null)
      this.profiles.set(
        senderId,
        mergeCustomerProfile(senderId, null, {}, now),
      );
    this.localPets.set(senderId, structuredClone(pets));
  }
}
