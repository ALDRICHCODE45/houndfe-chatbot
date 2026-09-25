/**
 * HD-R3b2a shared human-decision reservation table (INACTIVE until HD-R3b2b
 * wires both entry points). (route, request_key) is the replay identity; the
 * partial unique sender index allows one ACTIVE sender across both routes.
 * `intake` is null for LEGACY_OPS, else a RESTOCK object with sourceRequestId
 * = request_key; a missing/null sourceRequestId fails the check closed. Pending
 * legacy rows backfill as ACTIVE LEGACY_OPS; the sender
 * index is queued first so a duplicate sender aborts. `down` refuses non-empty.
 */

const TABLE = 'human_decision_reservations';
const REPLAY_INDEX = 'human_decision_reservations_route_request_key_idx';
const SENDER_INDEX = 'human_decision_reservations_active_sender_idx';
const SENDER_ACTIVE = "status = 'ACTIVE'";
const ROUTE_KEY_CHECK =
  "(route = 'LEGACY_OPS' AND request_key ~ '^[0-9a-f]{12}$') OR (route = 'RESTOCK' AND request_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')";
const INTAKE_CHECK =
  "(route = 'LEGACY_OPS' AND intake IS NULL) OR (route = 'RESTOCK' AND intake IS NOT NULL AND jsonb_typeof(intake) = 'object' AND COALESCE((intake ->> 'sourceRequestId') = request_key, false))";
const CHECKS = [
  [
    'human_decision_reservations_route_check',
    "route IN ('LEGACY_OPS', 'RESTOCK')",
  ],
  [
    'human_decision_reservations_status_check',
    "status IN ('ACTIVE', 'CLOSED')",
  ],
  [
    'human_decision_reservations_sender_nonblank_check',
    "btrim(sender_id) <> ''",
  ],
  ['human_decision_reservations_request_key_check', ROUTE_KEY_CHECK],
  ['human_decision_reservations_intake_check', INTAKE_CHECK],
];

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    sender_id: { type: 'text', notNull: true },
    route: { type: 'text', notNull: true },
    request_key: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    intake: { type: 'jsonb' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, name, `CHECK (${definition})`);

  pgm.createIndex(TABLE, ['route', 'request_key'], {
    name: REPLAY_INDEX,
    unique: true,
  });
  // Queued before the backfill so a duplicate pending sender aborts it.
  pgm.createIndex(TABLE, 'sender_id', {
    name: SENDER_INDEX,
    unique: true,
    where: SENDER_ACTIVE,
  });

  // Backfill: id -> request_key, customer_id -> sender_id, no conflict picker.
  pgm.sql(
    `INSERT INTO ${TABLE} (sender_id, route, request_key, status, intake)
SELECT customer_id, 'LEGACY_OPS', id, 'ACTIVE', NULL
FROM human_handoff_requests WHERE status = 'pending'`,
  );
};

exports.down = (pgm) => {
  // Queued fail-closed guard: raises and aborts before the drop runs.
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE}: table is non-empty';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(TABLE);
};
