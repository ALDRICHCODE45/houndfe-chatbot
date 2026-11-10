import { InMemoryWebhookDedupStore } from './in-memory-webhook-dedup.store';
import { runWebhookDedupContract } from './webhook-dedup.contract';

runWebhookDedupContract('InMemoryWebhookDedupStore', async (now) => ({
  store: new InMemoryWebhookDedupStore(now),
  cleanup: async () => undefined,
}));
