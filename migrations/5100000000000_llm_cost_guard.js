/**
 * Cost protection phase 1 (odd/tasks/cost-and-abuse-phase1.md S2/S5): the
 * persistent LLM spend ledger and the per-number LLM turn windows.
 *
 *   - llm_usage_ledger: one row per LLM call (source, tokens, estimated USD).
 *   - llm_spend_periods: running totals per Mexico City day (`day:YYYY-MM-DD`)
 *     and month (`month:YYYY-MM`), with the once-per-period 80% / 100% marks.
 *     The per-turn budget read is a primary-key lookup of two rows.
 *   - llm_sender_turns: admitted LLM turns per sender; the rolling hour/day
 *     counts read (sender_id, admitted_at). The admission prunes the
 *     sender's rows older than 24 h.
 *   - llm_guard_notices: the one team notice per sender per budget period,
 *     and the current per-number limit notice.
 *
 * Additive. `down` locks the tables and refuses while any call of the last
 * 32 days is booked: dropping it would silently reset the month's budget.
 */
const LEDGER = 'llm_usage_ledger';
const PERIODS = 'llm_spend_periods';
const TURNS = 'llm_sender_turns';
const NOTICES = 'llm_guard_notices';
const SOURCES = [
  'agent_turn',
  'agent_retry',
  'agent_render',
  'restock_classifier',
  'receipt_vision',
  'product_image',
  'ops_resume',
];
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = (pgm) => {
  pgm.createTable(LEDGER, {
    id: { type: 'bigserial', primaryKey: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    source: { type: 'text', notNull: true },
    input_tokens: { type: 'integer', notNull: true },
    output_tokens: { type: 'integer', notNull: true },
    usd: { type: 'numeric(14,8)', notNull: true },
    day_key: { type: 'text', notNull: true },
  });
  for (const [name, definition] of [
    ['source', `source IN (${quoted(SOURCES)})`],
    ['tokens', 'input_tokens >= 0 AND output_tokens >= 0'],
    ['usd', 'usd >= 0'],
    ['day_key', "day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'"],
  ])
    pgm.addConstraint(
      LEDGER,
      `${LEDGER}_${name}_check`,
      `CHECK (${definition})`,
    );
  pgm.createIndex(LEDGER, ['created_at'], { name: `${LEDGER}_created_at_idx` });

  pgm.createTable(PERIODS, {
    period_key: { type: 'text', primaryKey: true, collation: '"C"' },
    usd: { type: 'numeric(16,8)', notNull: true, default: 0 },
    input_tokens: { type: 'bigint', notNull: true, default: 0 },
    output_tokens: { type: 'bigint', notNull: true, default: 0 },
    calls: { type: 'integer', notNull: true, default: 0 },
    cap_usd: { type: 'numeric(14,4)', notNull: true },
    warned_80_at: { type: 'timestamptz' },
    exhausted_at: { type: 'timestamptz' },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint(
    PERIODS,
    `${PERIODS}_period_key_check`,
    "CHECK (period_key ~ '^(day:[0-9]{4}-[0-9]{2}-[0-9]{2}|month:[0-9]{4}-[0-9]{2})$')",
  );
  pgm.addConstraint(
    PERIODS,
    `${PERIODS}_amounts_check`,
    'CHECK (usd >= 0 AND cap_usd >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND calls >= 0)',
  );

  pgm.createTable(TURNS, {
    id: { type: 'bigserial', primaryKey: true },
    sender_id: { type: 'text', notNull: true, collation: '"C"' },
    admitted_at: { type: 'timestamptz', notNull: true },
  });
  pgm.addConstraint(
    TURNS,
    `${TURNS}_sender_id_check`,
    'CHECK (char_length(sender_id) BETWEEN 1 AND 128)',
  );
  pgm.createIndex(TURNS, ['sender_id', 'admitted_at'], {
    name: `${TURNS}_sender_admitted_idx`,
  });

  pgm.createTable(NOTICES, {
    sender_id: { type: 'text', notNull: true, collation: '"C"' },
    notice_key: { type: 'text', notNull: true, collation: '"C"' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint(NOTICES, `${NOTICES}_pkey`, {
    primaryKey: ['sender_id', 'notice_key'],
  });
  pgm.addConstraint(
    NOTICES,
    `${NOTICES}_notice_key_check`,
    "CHECK (notice_key = 'sender_limit' OR notice_key ~ '^budget:(day:[0-9]{4}-[0-9]{2}-[0-9]{2}|month:[0-9]{4}-[0-9]{2})$')",
  );
};

exports.down = (pgm) => {
  pgm.sql(
    `LOCK TABLE ${LEDGER}, ${PERIODS}, ${TURNS}, ${NOTICES} IN ACCESS EXCLUSIVE MODE;`,
  );
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${LEDGER} WHERE created_at > now() - interval '32 days'
       ) THEN
         RAISE EXCEPTION 'refusing to roll back llm cost guard: LLM spend of the last 32 days is booked';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(NOTICES);
  pgm.dropTable(TURNS);
  pgm.dropTable(PERIODS);
  pgm.dropTable(LEDGER);
};
