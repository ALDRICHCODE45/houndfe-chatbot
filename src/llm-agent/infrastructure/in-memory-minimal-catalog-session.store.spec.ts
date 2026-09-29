import type { MinimalCatalogTurn } from '../domain/minimal-catalog-session.store';
import { InMemoryMinimalCatalogSessionStore } from './in-memory-minimal-catalog-session.store';

const SENDER = '5215550001111';
const OTHER = '5215550002222';
const PRODUCT_A = '11111111-1111-4111-8111-111111111111';
const PRODUCT_B = '22222222-2222-4222-8222-222222222222';

const turn = (id: string): MinimalCatalogTurn => ({
  messages: [
    { role: 'user', content: `q-${id}` },
    { role: 'assistant', content: `a-${id}` },
  ],
  verifiedProductIds: [id],
});

describe('InMemoryMinimalCatalogSessionStore', () => {
  it('returns no turns for an unknown sender', () => {
    const store = new InMemoryMinimalCatalogSessionStore();
    expect(store.read(SENDER)).toEqual([]);
  });

  it('round-trips written turns in insertion order, keeping messages and verified ids together', () => {
    const store = new InMemoryMinimalCatalogSessionStore();
    const first = turn(PRODUCT_A);
    const second = turn(PRODUCT_B);

    store.write(SENDER, [first, second]);

    const read = store.read(SENDER);
    expect(read).toEqual([first, second]);
    expect(read[0].messages).toEqual(first.messages);
    expect(read[1].verifiedProductIds).toEqual([PRODUCT_B]);
  });

  it('replaces the sender history on overwrite', () => {
    const store = new InMemoryMinimalCatalogSessionStore();
    store.write(SENDER, [turn(PRODUCT_A)]);

    store.write(SENDER, [turn(PRODUCT_B)]);

    expect(store.read(SENDER)).toEqual([turn(PRODUCT_B)]);
  });

  it('isolates history per sender', () => {
    const store = new InMemoryMinimalCatalogSessionStore();
    store.write(SENDER, [turn(PRODUCT_A)]);

    expect(store.read(OTHER)).toEqual([]);
  });

  it('forgets every sender on a fresh store instance (restart loss)', () => {
    const first = new InMemoryMinimalCatalogSessionStore();
    first.write(SENDER, [turn(PRODUCT_A)]);

    const restarted = new InMemoryMinimalCatalogSessionStore();

    expect(restarted.read(SENDER)).toEqual([]);
  });
});
