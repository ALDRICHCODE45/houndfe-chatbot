import { InMemoryConversationStore } from './in-memory-conversation.store';
import {
  readMessages,
  type AgentMessage,
  type ConversationState,
} from '../domain/conversation-store';
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
runConversationStoreContract('InMemoryConversationStore', async () => ({
  store: new InMemoryConversationStore(),
}));

describe('InMemoryConversationStore', () => {
  let store: InMemoryConversationStore;

  beforeEach(() => {
    store = new InMemoryConversationStore();
  });

  // ──────────────────────────────────────────────────────────────
  // Adapter-specific: AgentMessage round-trip + missing-field default
  // ──────────────────────────────────────────────────────────────
  describe('atomic agent turns', () => {
    const timestamp = '2026-06-23T10:00:00.000Z';
    const later = '2026-06-23T11:00:00.000Z';
    const turn = () => ({
      expected: null,
      messages: [{ role: 'user' as const, content: 'first' }],
      catalogReferences: null,
      lastMessageAt: timestamp,
    });

    it('detaches committed inputs and rejects a stale completion without changing live siblings or timestamps', async () => {
      const input = turn();
      expect(await store.commitAgentTurn('sender', input)).toBe(true);
      input.messages[0].content = 'mutated caller';
      const original = structuredClone((await store.get('sender'))!);
      expect(original.data.messages![0].content).toBe('first');
      const expected = {
        messages: original.data.messages!,
        revision: original.data.agentRevision,
      };
      await store.update('sender', {
        lastMessageAt: later,
        data: { cart: 'live sibling' },
      });
      expect(
        await store.commitAgentTurn('sender', {
          ...turn(),
          expected,
          messages: [{ role: 'assistant', content: 'winner' }],
        }),
      ).toBe(true);
      const winner = structuredClone((await store.get('sender'))!);
      expect(winner.lastMessageAt).toBe(later);
      expect(winner.data.cart).toBe('live sibling');
      expect(winner.data.agentRevision).not.toBe(original.data.agentRevision);
      expect(
        await store.commitAgentTurn('sender', { ...turn(), expected }),
      ).toBe(false);
      expect(await store.get('sender')).toEqual(winner);
    });

    it('allows first-contact merge into an empty sibling-created row but not populated history', async () => {
      await store.create('sender', {
        lastMessageAt: later,
        data: { cart: 'sibling' },
      });
      expect(await store.commitAgentTurn('sender', turn())).toBe(true);
      expect((await store.get('sender'))!.data.cart).toBe('sibling');
      expect(await store.commitAgentTurn('sender', turn())).toBe(false);
      await store.create('populated', {
        lastMessageAt: timestamp,
        data: { messages: [{ role: 'user', content: 'another' }] },
      });
      expect(await store.commitAgentTurn('populated', turn())).toBe(false);
    });

    it('does not recreate a missing row for an existing-row expectation', async () => {
      expect(
        await store.commitAgentTurn('deleted', {
          ...turn(),
          expected: { messages: [] },
        }),
      ).toBe(false);
      expect(await store.get('deleted')).toBeNull();
    });

    it('compares full history as well as revision and preserves all owned keys against generic updates', async () => {
      await store.commitAgentTurn('sender', turn());
      const original = structuredClone((await store.get('sender'))!);
      expect(
        await store.commitAgentTurn('sender', {
          ...turn(),
          expected: { messages: [], revision: original.data.agentRevision },
        }),
      ).toBe(false);
      await store.update('sender', {
        lastMessageAt: timestamp,
        data: {
          messages: [],
          agentRevision: 'forged',
          catalogReferences: null,
          arbitrary: 'new',
        },
      });
      expect((await store.get('sender'))!.data).toEqual({
        ...original.data,
        arbitrary: 'new',
      });
      await store.update('new', {
        lastMessageAt: timestamp,
        data: {
          messages: [],
          agentRevision: 'forged',
          catalogReferences: null,
        },
      });
      expect((await store.get('new'))!.data).toEqual({});
    });
  });

  describe('messages field', () => {
    it('readMessages() defaults to [] when the field is absent', async () => {
      await store.create('wa-empty-msg', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'init' },
      });

      const state = await store.get('wa-empty-msg');
      expect(readMessages(state!)).toEqual([]);
    });

    it('round-trips AgentMessage[] through an atomic agent turn', async () => {
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

      expect(
        await store.commitAgentTurn('wa-msgs', {
          expected: { messages: [] },
          lastMessageAt: '2026-06-23T11:00:00.000Z',
          messages: transcript,
          catalogReferences: null,
        }),
      ).toBe(true);

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

  // ──────────────────────────────────────────────────────────────
  // SQ-5C2c2b4b1: atomic conditional pendingHumanRequest clear
  // ──────────────────────────────────────────────────────────────
  describe('clearPendingHumanRequest', () => {
    const at = '2026-06-23T12:00:00.000Z';
    const REQUEST_ID = 'abc123def456';
    const canonical = {
      requestId: REQUEST_ID,
      ref: `HF-${REQUEST_ID}`,
      createdAt: at,
      customerNotifiedAt: at,
    };

    async function seed(
      data: ConversationState['data'],
    ): Promise<InMemoryConversationStore> {
      const seeded = new InMemoryConversationStore();
      await seeded.create('wa-hf', { lastMessageAt: at, data });
      return seeded;
    }

    it('clears a matching canonical marker to JSON null and preserves siblings', async () => {
      const seeded = await seed({
        messages: [{ role: 'user', content: 'hola' }],
        pendingHumanRequest: canonical,
        receiptAmountPointer: {
          receiptMediaId: 'rm-1',
          saleId: 'sale-1',
          receiptVersion: '7',
        },
        shippingApproval: { decision: 'approve' },
      });

      await expect(
        seeded.clearPendingHumanRequest('wa-hf', REQUEST_ID),
      ).resolves.toBe(true);

      const state = await seeded.get('wa-hf');
      expect(Object.hasOwn(state!.data, 'pendingHumanRequest')).toBe(true);
      expect(state!.data.pendingHumanRequest).toBeNull();
      expect(state!.data.receiptAmountPointer).toEqual({
        receiptMediaId: 'rm-1',
        saleId: 'sale-1',
        receiptVersion: '7',
      });
      expect(state!.data.shippingApproval).toEqual({ decision: 'approve' });
      expect(state!.data.messages).toEqual([{ role: 'user', content: 'hola' }]);
      expect(state!.lastMessageAt).toBe(at);
    });

    it('returns false without writes when the stored id differs', async () => {
      const seeded = await seed({
        pendingHumanRequest: {
          ...canonical,
          requestId: 'ffffffffffff',
          ref: 'HF-ffffffffffff',
        },
      });
      const before = structuredClone(await seeded.get('wa-hf'));
      await expect(
        seeded.clearPendingHumanRequest('wa-hf', REQUEST_ID),
      ).resolves.toBe(false);
      expect(await seeded.get('wa-hf')).toEqual(before);
    });

    it('rejects a marker whose canonical fields are inherited, not own keys', async () => {
      const spoofed = Object.assign(Object.create(canonical), {
        a: 1,
        b: 2,
        c: 3,
        d: 4,
      }) as ConversationState['data']['pendingHumanRequest'];
      const seeded = await seed({ pendingHumanRequest: spoofed });
      await expect(
        seeded.clearPendingHumanRequest('wa-hf', REQUEST_ID),
      ).resolves.toBe(false);
      expect((await seeded.get('wa-hf'))!.data.pendingHumanRequest).toBe(
        spoofed,
      );
    });

    it.each([
      ['absent', {}],
      ['non-object', { pendingHumanRequest: 'nope' }],
      [
        'missing key',
        {
          pendingHumanRequest: {
            requestId: REQUEST_ID,
            ref: `HF-${REQUEST_ID}`,
            createdAt: at,
          },
        },
      ],
      ['wrong ref', { pendingHumanRequest: { ...canonical, ref: 'HF-x' } }],
      [
        'empty createdAt',
        { pendingHumanRequest: { ...canonical, createdAt: '' } },
      ],
      ['extra key', { pendingHumanRequest: { ...canonical, extra: 'x' } }],
    ] as const)(
      'returns false without writes for a %s marker',
      async (_, data) => {
        const seeded = await seed(data as ConversationState['data']);
        const before = structuredClone(await seeded.get('wa-hf'));
        await expect(
          seeded.clearPendingHumanRequest('wa-hf', REQUEST_ID),
        ).resolves.toBe(false);
        expect(await seeded.get('wa-hf')).toEqual(before);
      },
    );

    it.each(['', 'ABC123DEF456', 'abc123', 'abc123def4567'])(
      'returns false without writes for invalid requestId %p',
      async (requestId) => {
        const seeded = await seed({ pendingHumanRequest: canonical });
        const before = structuredClone(await seeded.get('wa-hf'));
        await expect(
          seeded.clearPendingHumanRequest('wa-hf', requestId),
        ).resolves.toBe(false);
        expect(await seeded.get('wa-hf')).toEqual(before);
      },
    );

    it('returns false when the sender is empty', async () => {
      const seeded = await seed({ pendingHumanRequest: canonical });
      await expect(
        seeded.clearPendingHumanRequest('', REQUEST_ID),
      ).resolves.toBe(false);
    });
  });
});
