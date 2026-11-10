import { runConversationGateStoreContract } from './conversation-gate-store.contract';
import { InMemoryConversationGateStore } from './in-memory-conversation-gate.store';

runConversationGateStoreContract('in-memory', (now) =>
  Promise.resolve({ store: new InMemoryConversationGateStore(now) }),
);
