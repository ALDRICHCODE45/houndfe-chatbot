import { runCustomerProfileStoreContract } from './customer-profile-store.contract';
import { InMemoryCustomerProfileStore } from './in-memory-customer-profile.store';

runCustomerProfileStoreContract('in-memory', () =>
  Promise.resolve({ store: new InMemoryCustomerProfileStore() }),
);

describe('InMemoryCustomerProfileStore', () => {
  it('returns detached copies', async () => {
    const store = new InMemoryCustomerProfileStore();
    const saved = await store.upsert(
      '5215550001111',
      {
        displayName: 'Ana',
        lastOrder: {
          folio: 'A-1',
          confirmedAt: '2026-11-01T10:00:00.000Z',
          totalCents: 1000,
        },
      },
      new Date('2026-11-07T00:00:00.000Z'),
    );
    saved!.lastOrder!.folio = 'mutated';
    await expect(store.read('5215550001111')).resolves.toMatchObject({
      lastOrder: { folio: 'A-1' },
    });
  });
});
