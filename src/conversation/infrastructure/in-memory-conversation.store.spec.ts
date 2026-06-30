import { InMemoryConversationStore } from './in-memory-conversation.store';
import { readMessages, type AgentMessage } from '../domain/conversation-store';

/**
 * Unit tests for InMemoryConversationStore.
 *
 * Spec scenarios covered:
 *   - New sender state is created and read back            (create + get)
 *   - Unknown sender has no state                          (get → null)
 *   - Existing sender state is updated, senderId preserved (update patch)
 *   - Update on unknown sender UPSERTs (no exception)      (UPSERT contract)
 *   - messages field defaults to [] when absent            (AgentMessage[])
 */
describe('InMemoryConversationStore', () => {
  let store: InMemoryConversationStore;

  beforeEach(() => {
    store = new InMemoryConversationStore();
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario: New sender state is created and read back
  // ──────────────────────────────────────────────────────────────
  describe('create', () => {
    it('persists state for a new sender and returns it with the senderId', async () => {
      const result = await store.create('wa-001', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'greeting' },
      });

      expect(result.senderId).toBe('wa-001');
      expect(result.lastMessageAt).toBe('2026-06-23T10:00:00.000Z');
      expect(result.data).toEqual({ step: 'greeting' });
    });

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
  // Scenario: Unknown sender has no state
  // ──────────────────────────────────────────────────────────────
  describe('get', () => {
    it('returns null for a sender that has never been stored', async () => {
      const result = await store.get('never-seen');
      expect(result).toBeNull();
    });

    it('returns the stored state for a known sender', async () => {
      await store.create('wa-known', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'init' },
      });

      const result = await store.get('wa-known');

      expect(result).not.toBeNull();
      expect(result!.senderId).toBe('wa-known');
      expect(result!.lastMessageAt).toBe('2026-06-23T09:00:00.000Z');
      expect(result!.data).toEqual({ step: 'init' });
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario: Existing sender state is updated
  // ──────────────────────────────────────────────────────────────
  describe('update', () => {
    it('patches lastMessageAt and leaves data untouched', async () => {
      await store.create('wa-update', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'cart' },
      });

      const updated = await store.update('wa-update', {
        lastMessageAt: '2026-06-23T10:30:00.000Z',
      });

      expect(updated.senderId).toBe('wa-update');
      expect(updated.lastMessageAt).toBe('2026-06-23T10:30:00.000Z');
      expect(updated.data).toEqual({ step: 'cart' }); // unchanged
    });

    it('patches data field and leaves lastMessageAt untouched', async () => {
      await store.create('wa-data-patch', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'greeting' },
      });

      const updated = await store.update('wa-data-patch', {
        data: { step: 'cart', productId: 'prod-123' },
      });

      expect(updated.senderId).toBe('wa-data-patch');
      expect(updated.lastMessageAt).toBe('2026-06-23T09:00:00.000Z'); // unchanged
      expect(updated.data).toEqual({ step: 'cart', productId: 'prod-123' });
    });

    it('subsequent get reflects the patched state', async () => {
      await store.create('wa-persist', {
        lastMessageAt: '2026-06-23T08:00:00.000Z',
        data: {},
      });

      await store.update('wa-persist', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
      });

      const found = await store.get('wa-persist');
      expect(found!.lastMessageAt).toBe('2026-06-23T09:00:00.000Z');
    });

    it('UPSERTs when sender does not exist (no exception thrown)', async () => {
      const created = await store.update('ghost-sender', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { messages: [] },
      });

      expect(created.senderId).toBe('ghost-sender');
      expect(created.lastMessageAt).toBe('2026-06-23T10:00:00.000Z');
      expect(created.data).toEqual({ messages: [] });

      // A subsequent get must reflect the new record.
      const found = await store.get('ghost-sender');
      expect(found).toEqual(created);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario: AgentMessage round-trip + missing-field default
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
        { role: 'tool', toolCallId: 'call-1', content: { now: '2026-06-23T11:00:00.000Z' } },
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
});
