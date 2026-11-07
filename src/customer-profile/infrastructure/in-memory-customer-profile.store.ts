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
    return Promise.resolve(this.profiles.delete(senderId));
  }
}
