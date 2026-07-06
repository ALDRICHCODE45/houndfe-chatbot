import { InMemoryConversationStore } from './in-memory-conversation.store';
import { readMessages, type AgentMessage } from '../domain/conversation-store';
import { runConversationStoreContract } from './conversation-store.contract';

/**
 * Unit tests for InMemoryConversationStore.
 *
 * Adapter-specific:
 *   - messages field defaults to [] when absent (readMessages() helper)
 *
 * Port contract: realised through the shared `runConversationStoreContract`
 * factory, ensuring byte-identical parity with the Postgres adapter.
 */
runConversationStoreContract(
  'InMemoryConversationStore',
  async () => ({ store: new InMemoryConversationStore() }),
);

describe('InMemoryConversationStore', () => {
  let store: InMemoryConversationStore;

  beforeEach(() => {
    store = new InMemoryConversationStore();
  });

  // ──────────────────────────────────────────────────────────────
  // Adapter-specific: AgentMessage round-trip + missing-field default
  // ──────────────────────────────────────────────────────────────
  describe('messages field', () => {
    it('readMessages() defaults to [] when the field is absent', async () => {
      await store.create('wa-empty-msg', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'init' },
      });

      const state = await store.get('wa-empty-msg');
      expect(readMessages(state!)).toEqual([]);
    });

    it('round-trips AgentMessage[] through update', async () => {
      await store.create('wa-msgs', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: {},
      });

      const transcript: AgentMessage[] = [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'Hola' },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: { now: '2026-06-23T11:00:00.000Z' },
        },
      ];

      await store.update('wa-msgs', {
        lastMessageAt: '2026-06-23T11:00:00.000Z',
        data: { messages: transcript },
      });

      const state = await store.get('wa-msgs');
      expect((state!.data as { messages: AgentMessage[] }).messages).toEqual(
        transcript,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Adapter-specific: independent senders do not collide
  // ──────────────────────────────────────────────────────────────
  describe('per-sender isolation', () => {
    it('allows independent records for distinct senders', async () => {
      await store.create('wa-001', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: {},
      });
      await store.create('wa-002', {
        lastMessageAt: '2026-06-23T10:01:00.000Z',
        data: {},
      });

      const first = await store.get('wa-001');
      const second = await store.get('wa-002');

      expect(first!.senderId).toBe('wa-001');
      expect(second!.senderId).toBe('wa-002');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Adapter-specific: missing lastMessageAt guard mirrors the
  // in-memory UPSERT contract — the contract scenarios above do
  // not exercise the throw branch.
  // ──────────────────────────────────────────────────────────────
  describe('missing lastMessageAt guard', () => {
    it('throws when update() omits lastMessageAt', async () => {
      await expect(
        store.update('wa-no-ts', { data: { foo: 'bar' } }),
      ).rejects.toThrow(/lastMessageAt/);
    });
  });
});