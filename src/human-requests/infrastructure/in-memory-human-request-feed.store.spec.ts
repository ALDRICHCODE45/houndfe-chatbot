import { runHumanRequestFeedStoreContract } from './human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from './in-memory-human-request-feed.store';

runHumanRequestFeedStoreContract('in-memory', () =>
  Promise.resolve({
    store: new InMemoryHumanRequestFeedStore(),
    cleanup: () => Promise.resolve(),
  }),
);
