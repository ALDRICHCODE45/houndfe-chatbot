import { InMemoryCustomerProfileStore } from './in-memory-customer-profile.store';
import { InMemoryLocalPetStore } from './in-memory-local-pet.store';
import { runLocalPetStoreContract } from './local-pet-store.contract';

runLocalPetStoreContract('in-memory', () => {
  const profiles = new InMemoryCustomerProfileStore();
  return Promise.resolve({
    profiles,
    store: new InMemoryLocalPetStore(profiles),
  });
});
