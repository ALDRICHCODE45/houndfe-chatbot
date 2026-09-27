import type { Pool } from 'pg';
import { PostgresConversationStore } from './postgres-conversation.store';
import type { AgentTurnCommit } from '../domain/conversation-store';

/** SQL shape/binding tests only: no database or locking claims. */
describe('Postgres agent turn conditional SQL', () => {
  const turn = (): AgentTurnCommit => ({
    expected: {
      messages: [{ role: 'user', content: 'original' }],
      revision: 'old-revision',
    },
    messages: [{ role: 'assistant', content: 'reply' }],
    catalogReferences: null,
    lastMessageAt: '2026-06-23T10:00:00.000Z',
  });
  function fixture(rowCount = 1) {
    const query = jest
      .fn<Promise<{ rowCount: number }>, [string, unknown[]]>()
      .mockResolvedValue({ rowCount });
    return {
      query,
      store: new PostgresConversationStore({ query } as unknown as Pool),
    };
  }

  it('uses one conditional UPDATE for an existing row, merges live data and preserves later timestamps', async () => {
    const { store, query } = fixture();
    const input = turn();
    expect(await store.commitAgentTurn('sender', input)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/^UPDATE conversation_state/);
    expect(sql).not.toContain('INSERT');
    expect(sql).toContain(
      'GREATEST(conversation_state.last_message_at, $2::timestamptz)',
    );
    expect(sql).toContain('data = conversation_state.data || $3::jsonb');
    expect(sql).toContain(
      "COALESCE(conversation_state.data->'messages', '[]'::jsonb) = $4::jsonb",
    );
    expect(sql).toContain(
      "conversation_state.data->>'agentRevision' = $5::text",
    );
    expect(values[0]).toBe('sender');
    expect(values[1]).toBe(input.lastMessageAt);
    expect(values[3]).toBe(JSON.stringify(input.expected!.messages));
    expect(values[4]).toBe('old-revision');
    const data = JSON.parse(values[2] as string) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([
      'agentRevision',
      'catalogReferences',
      'messages',
    ]);
    expect(data.messages).toEqual(input.messages);
    expect(data.agentRevision).not.toBe('old-revision');
    input.messages[0].content = 'mutated';
    expect(JSON.parse(values[2] as string)).toEqual(data);
  });

  it('inserts first contact but merges sibling-created rows only with empty history and absent revision', async () => {
    const { store, query } = fixture();
    await store.commitAgentTurn('sender', { ...turn(), expected: null });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/^INSERT INTO conversation_state/);
    expect(sql).toContain('ON CONFLICT (sender_id) DO UPDATE');
    expect(sql).toContain(
      "$5::text IS NULL AND NOT (conversation_state.data ? 'agentRevision')",
    );
    expect(values.slice(3)).toEqual(['[]', null]);
  });

  it('returns false for a lost CAS or deleted row without retrying or recreating', async () => {
    const { store, query } = fixture(0);
    await expect(store.commitAgentTurn('sender', turn())).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain('INSERT');
  });

  it('generates a fresh revision even when the committed messages are unchanged', async () => {
    const { store, query } = fixture();
    await store.commitAgentTurn('sender', turn());
    await store.commitAgentTurn('sender', turn());
    const revisions = query.mock.calls.map(
      ([, values]) =>
        (JSON.parse(values[2] as string) as { agentRevision: string })
          .agentRevision,
    );
    expect(revisions[0]).not.toBe(revisions[1]);
  });
});
