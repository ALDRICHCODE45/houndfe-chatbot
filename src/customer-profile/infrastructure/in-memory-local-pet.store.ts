import type { LocalPet, LocalPetStore } from '../domain/customer-pets';
import type { InMemoryCustomerProfileStore } from './in-memory-customer-profile.store';

/**
 * In-memory LocalPetStore for tests and the conversation eval. It shares the
 * profile rows of an `InMemoryCustomerProfileStore` (like the real column on
 * the same table): a profile delete removes the local pets too.
 */
export class InMemoryLocalPetStore implements LocalPetStore {
  constructor(private readonly profiles: InMemoryCustomerProfileStore) {}

  read(senderId: string): Promise<LocalPet[]> {
    return Promise.resolve(this.profiles.readLocalPets(senderId));
  }

  write(senderId: string, pets: LocalPet[], now: Date): Promise<void> {
    this.profiles.writeLocalPets(senderId, pets, now);
    return Promise.resolve();
  }
}
