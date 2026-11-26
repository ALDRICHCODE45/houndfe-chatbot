import type { LocalPet, LocalPetStore } from '../domain/customer-pets';
import type { CustomerProfileStore } from '../domain/customer-profile';

/**
 * Shared contract for every `LocalPetStore` adapter (T4b, S8): round-trip of
 * the prospect's local pet list, replace semantics (an uploaded entry is
 * removed), invalid entries dropped on read, invalid sender ids refused, the
 * profile's other columns untouched.
 */
export type LocalPetStoreFactory = () => Promise<{
  store: LocalPetStore;
  profiles: CustomerProfileStore;
  cleanup?: () => Promise<void>;
}>;

const SENDER = '5215550001111';
const OTHER = '5215550002222';
const T1 = new Date('2026-11-23T12:00:00.000Z');

const luna: LocalPet = {
  id: 'b1f0c7a2-0000-4000-8000-000000000001',
  name: 'Luna',
  species: 'perro',
  breed: 'labrador',
  birthDate: '2023-01-01',
  birthDatePrecision: 'YEAR',
  createdAt: T1.toISOString(),
};
const michi: LocalPet = {
  id: 'b1f0c7a2-0000-4000-8000-000000000002',
  species: 'gato',
  createdAt: T1.toISOString(),
};

export function runLocalPetStoreContract(
  label: string,
  makeStore: LocalPetStoreFactory,
): void {
  describe(`LocalPetStore contract — ${label}`, () => {
    let store: LocalPetStore;
    let profiles: CustomerProfileStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      ({ store, profiles, cleanup } = await makeStore());
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it('reads [] for an unknown sender', async () => {
      await expect(store.read(SENDER)).resolves.toEqual([]);
    });

    it('writes and reads back the list (creating the profile row)', async () => {
      await store.write(SENDER, [luna, michi], T1);
      await expect(store.read(SENDER)).resolves.toEqual([luna, michi]);
      await expect(store.read(OTHER)).resolves.toEqual([]);
      await expect(profiles.read(SENDER)).resolves.toMatchObject({
        senderId: SENDER,
        register: 'usted',
      });
    });

    it('replaces the list: a removed entry is gone, [] clears it', async () => {
      await store.write(SENDER, [luna, michi], T1);
      await store.write(SENDER, [michi], T1);
      await expect(store.read(SENDER)).resolves.toEqual([michi]);
      await store.write(SENDER, [], T1);
      await expect(store.read(SENDER)).resolves.toEqual([]);
    });

    it('an empty list never creates a profile', async () => {
      await store.write(SENDER, [], T1);
      await expect(profiles.read(SENDER)).resolves.toBeNull();
    });

    it('keeps the profile untouched', async () => {
      await profiles.upsert(SENDER, { displayName: 'Ana', register: 'tu' }, T1);
      await store.write(SENDER, [luna], T1);
      await expect(profiles.read(SENDER)).resolves.toMatchObject({
        displayName: 'Ana',
        register: 'tu',
      });
    });

    it('refuses a sender id that is not wa_id digits', async () => {
      await store.write('sender-1', [luna], T1);
      await expect(store.read('sender-1')).resolves.toEqual([]);
    });

    it('a profile delete ("olvida mis datos") removes the local pets', async () => {
      await store.write(SENDER, [luna], T1);
      await profiles.delete(SENDER);
      await expect(store.read(SENDER)).resolves.toEqual([]);
    });
  });
}
