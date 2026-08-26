/**
 * node-pg-migrate up/down for the human-handoff request table.
 *
 * Owns the durable record of every bot → human escalation. The
 * companion PostgresHumanHandoffStore reads / writes / resolves the
 * rows via the HUMAN_HANDOFF_STORE Symbol token.
 *
 * Schema:
 *   id            text PK         — 12 lowercase hex chars; ref = `HF-${id}`
 *   customer_id   text NOT NULL   — senderId of the customer
 *   agent_id      text NOT NULL   — OPS_CHANNEL_PHONE at create (ADR-24)
 *   kind          text NOT NULL   — see HUMAN_HANDOFF_KINDS in
 *                                   src/human-handoff/domain/human-handoff.types.ts
 *   digest        jsonb NOT NULL  — per-kind payload
 *   status        text NOT NULL   — 'pending' | 'resolved'
 *   resolution    jsonb           — set on resolve; null while pending
 *   created_at    timestamptz     — DEFAULT now()
 *   resolved_at   timestamptz     — set on resolve; null while pending
 *
 * Index (status, created_at) backs `findLatestPendingForAgent`.
 * No CHECK on `kind` text — the union is owned in code (so adding
 * `shipping_approval` later doesn't require a migration).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('human_handoff_requests', {
    id: { type: 'text', primaryKey: true },
    customer_id: { type: 'text', notNull: true },
    agent_id: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true },
    digest: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    resolution: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
  });
  pgm.createIndex('human_handoff_requests', ['status', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('human_handoff_requests');
};
