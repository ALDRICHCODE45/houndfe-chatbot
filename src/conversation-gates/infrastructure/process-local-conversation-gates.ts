import { ConversationGates } from '../application/conversation-gates';
import { InMemoryConversationGateStore } from './in-memory-conversation-gate.store';

/**
 * Gates over a private in-memory store: the fallback for services built
 * outside Nest (unit specs). Behaves exactly like the durable gates within one
 * process and forgets everything on restart.
 */
export function processLocalConversationGates(
  now: () => number = () => Date.now(),
): ConversationGates {
  return new ConversationGates(
    new InMemoryConversationGateStore(() => new Date(now())),
    now,
  );
}
