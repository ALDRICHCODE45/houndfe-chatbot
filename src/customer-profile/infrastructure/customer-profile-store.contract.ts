import type {
  CustomerProfilePatch,
  CustomerProfileStore,
} from '../domain/customer-profile';

/**
 * Shared contract for every `CustomerProfileStore` adapter: round-trip,
 * merge-only upsert (a known field is never erased), bounded/sanitized
 * text, invalid sender ids refused, delete. T6b: a `pet` in a patch from
 * an older caller is ignored (the profile keeps no pet).
 */
export type CustomerProfileStoreFactory = () => Promise<{
  store: CustomerProfileStore;
  cleanup?: () => Promise<void>;
}>;

const SENDER = '5215550001111';
const OTHER = '5215550002222';
const T1 = new Date('2026-11-07T12:00:00.000Z');
const T2 = new Date('2026-11-08T12:00:00.000Z');

export function runCustomerProfileStoreContract(
  label: string,
  makeStore: CustomerProfileStoreFactory,
): void {
  describe(`CustomerProfileStore contract — ${label}`, () => {
    let store: CustomerProfileStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      ({ store, cleanup } = await makeStore());
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it('reads null for an unknown sender', async () => {
      await expect(store.read(SENDER)).resolves.toBeNull();
    });

    it('creates with the usted defaults and reads it back', async () => {
      const created = await store.upsert(SENDER, { displayName: 'Ana' }, T1);
      expect(created).toEqual({
        senderId: SENDER,
        displayName: 'Ana',
        register: 'usted',
        emojis: false,
        tone: 'neutral',
        updatedAt: T1.toISOString(),
      });
      await expect(store.read(SENDER)).resolves.toEqual(created);
      await expect(store.read(OTHER)).resolves.toBeNull();
    });

    it('merges without erasing known fields', async () => {
      await store.upsert(
        SENDER,
        {
          displayName: 'Ana',
          preferredName: 'Anita',
          register: 'tu',
          emojis: true,
          tone: 'casual',
          lastOrder: {
            folio: 'A-1',
            confirmedAt: '2026-11-01T10:00:00.000Z',
            totalCents: 1000,
          },
        },
        T1,
      );
      const merged = await store.upsert(
        SENDER,
        {
          displayName: null,
          preferredName: '  ',
          register: null,
          // One real value, so the write happens (T6b: was a pet fact).
          tone: 'casual',
          lastOrder: null,
        },
        T2,
      );
      const expected = {
        senderId: SENDER,
        displayName: 'Ana',
        preferredName: 'Anita',
        register: 'tu',
        emojis: true,
        tone: 'casual',
        lastOrder: {
          folio: 'A-1',
          confirmedAt: '2026-11-01T10:00:00.000Z',
          totalCents: 1000,
        },
        updatedAt: T2.toISOString(),
      };
      expect(merged).toEqual(expected);
      await expect(store.read(SENDER)).resolves.toEqual(expected);
    });

    it('the latest explicit style and order win', async () => {
      await store.upsert(SENDER, { register: 'tu', emojis: true }, T1);
      await store.upsert(
        SENDER,
        {
          register: 'usted',
          emojis: false,
          tone: 'formal',
          lastOrder: {
            folio: 'A-2',
            confirmedAt: '2026-11-08T10:00:00.000Z',
            totalCents: 2000,
          },
        },
        T2,
      );
      await expect(store.read(SENDER)).resolves.toMatchObject({
        register: 'usted',
        emojis: false,
        tone: 'formal',
        lastOrder: { folio: 'A-2', totalCents: 2000 },
      });
    });

    it('stores sanitized, bounded text', async () => {
      const saved = await store.upsert(
        SENDER,
        { displayName: ' A\u0000na\n ', preferredName: 'x'.repeat(900) },
        T1,
      );
      expect(saved?.displayName).toBe('Ana');
      expect(saved?.preferredName).toHaveLength(40);
    });

    it('an empty patch creates nothing', async () => {
      await expect(
        store.upsert(SENDER, { displayName: null }, T1),
      ).resolves.toBeNull();
      await expect(store.read(SENDER)).resolves.toBeNull();
    });

    it('refuses a sender id that is not wa_id digits', async () => {
      await expect(
        store.upsert('sender-1', { displayName: 'Ana' }, T1),
      ).resolves.toBeNull();
      await expect(store.read('sender-1')).resolves.toBeNull();
    });

    it('T6b: a `pet` in a patch from an older caller is ignored (never stored, never read back)', async () => {
      // SAFETY: an older build's patch shape, no longer in the type.
      const legacy = {
        displayName: 'Ana',
        pet: { name: 'Luna', species: 'perro' },
      } as unknown as CustomerProfilePatch;
      const saved = await store.upsert(SENDER, legacy, T1);
      const expected = {
        senderId: SENDER,
        displayName: 'Ana',
        register: 'usted',
        emojis: false,
        tone: 'neutral',
        updatedAt: T1.toISOString(),
      };
      expect(saved).toEqual(expected);
      await expect(store.read(SENDER)).resolves.toEqual(expected);
      // A pet alone is an empty patch: no row for an unknown sender.
      await expect(
        store.upsert(
          OTHER,
          { pet: { name: 'Max' } } as unknown as CustomerProfilePatch,
          T1,
        ),
      ).resolves.toBeNull();
      await expect(store.read(OTHER)).resolves.toBeNull();
    });

    it('deletes the profile', async () => {
      await store.upsert(SENDER, { displayName: 'Ana' }, T1);
      await store.upsert(OTHER, { displayName: 'Beto' }, T1);
      await expect(store.delete(SENDER)).resolves.toBe(true);
      await expect(store.read(SENDER)).resolves.toBeNull();
      await expect(store.delete(SENDER)).resolves.toBe(false);
      await expect(store.read(OTHER)).resolves.toMatchObject({
        displayName: 'Beto',
      });
    });
  });
}
