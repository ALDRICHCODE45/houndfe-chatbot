import { runTranscriptStoreContract } from './transcript-store.contract';
import { InMemoryTranscriptStore } from './in-memory-transcript.store';

runTranscriptStoreContract('in-memory', () =>
  Promise.resolve({ store: new InMemoryTranscriptStore() }),
);

describe('InMemoryTranscriptStore', () => {
  it('returns detached copies', async () => {
    const store = new InMemoryTranscriptStore();
    await store.append({
      senderId: '5215550001111',
      waMessageId: 'wamid.1',
      direction: 'IN',
      author: 'CUSTOMER',
      type: 'image',
      media: { providerMediaId: 'm-1' },
      observedAt: new Date('2026-11-09T16:00:00.000Z'),
    });
    const [first] = await store.listRecent('5215550001111', 1);
    first.media!.providerMediaId = 'mutated';
    const [again] = await store.listRecent('5215550001111', 1);
    expect(again.media).toEqual({ providerMediaId: 'm-1' });
  });
});
