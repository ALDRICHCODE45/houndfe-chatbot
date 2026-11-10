import { runBackendOutboxStoreContract } from './backend-outbox-store.contract';
import { InMemoryBackendOutboxStore } from './in-memory-backend-outbox.store';

runBackendOutboxStoreContract('in-memory', () =>
  Promise.resolve({ store: new InMemoryBackendOutboxStore() }),
);

describe('InMemoryBackendOutboxStore', () => {
  it('returns detached copies', async () => {
    const store = new InMemoryBackendOutboxStore();
    const { entry } = await store.enqueue({
      conversationRef: 'wa:5215550001111',
      kind: 'SESSION_ACK',
      idempotencyKey: 'k',
      payload: { epoch: 1 },
    });
    entry.payload.epoch = 99;
    const [claimed] = await store.claimHeads(1, 'owner', 60_000);
    expect(claimed.payload).toEqual({ epoch: 1 });
  });
});
