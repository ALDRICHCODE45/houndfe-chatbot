import { InMemoryWebhookDedupStore } from './in-memory-webhook-dedup.store';
import { runWebhookDedupContract } from './webhook-dedup.contract';

runWebhookDedupContract('InMemoryWebhookDedupStore', async () => ({
  store: new InMemoryWebhookDedupStore(),
  cleanup: async () => undefined,
}));
