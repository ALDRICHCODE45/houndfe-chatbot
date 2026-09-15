/**
 * WU14B expand phase — rolling-deploy compatibility (native R4).
 *
 * Old binaries only know the legacy `capability_key_version integer`
 * channel; new binaries read and write the canonical text channel. An
 * in-place type conversion cannot serve both, so this migration instead:
 *   1. adds a nullable canonical `capability_key_version_text` column with
 *      a canonical positive-decimal CHECK (`^[1-9][0-9]*$`, arbitrary
 *      magnitude),
 *   2. backfills it losslessly from existing positive legacy integers, and
 *   3. widens the `receipt_media_accepted_object_evidence` composite so
 *      EITHER capability channel satisfies the lifecycle invariants —
 *      old-binary integer evidence and new canonical text evidence both
 *      stay valid across the rolling window.
 * New code dual-writes int32-compatible versions into the legacy column and
 * writes huge versions only as canonical text (legacy stays NULL). The
 * contract phase that removes the legacy column is deliberately deferred.
 *
 * Down fails closed before any data loss while a canonical text value is
 * non-canonical, diverges from non-null legacy evidence, or exceeds the
 * legacy signed int32 range (pure lexical checks); otherwise it
 * synchronizes legacy evidence, restores the legacy-only composite, and
 * drops only the expand-phase text column/check. Existing migrations are
 * never edited.
 *
 * node-pg-migrate execution model used deliberately: `pgm.*` helpers and
 * `pgm.sql()` QUEUE steps that run in registration order after the up/down
 * function returns, while `pgm.db.query()` executes immediately. So the
 * composite definitions are captured immediately (pre-DDL) and every data
 * statement is queued (up) or immediate (down, against the pre-DDL schema
 * where both channels still exist) — never in a broken interleaving.
 */

const TABLE = 'receipt_media';
const COLUMN = 'capability_key_version';
const TEXT_COLUMN = 'capability_key_version_text';
const CANONICAL = '^[1-9][0-9]*$';
const MAX_INT32 = '2147483647';
const TEXT_CHECK = 'receipt_media_capability_key_version_text_canonical';
const COMPOSITE = 'receipt_media_accepted_object_evidence';

/** Bare expression of the tracked composite constraint, fail-closed on any
 *  unexpected shape; the deparsed definition is trusted only as evidence. */
const compositeExpression = async (db) => {
  const def = (
    await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = $1::regclass AND conname = $2 AND contype = 'c'`,
      [TABLE, COMPOSITE],
    )
  ).rows[0]?.def;
  if (typeof def !== 'string' || !def.startsWith('CHECK ')) {
    throw new Error(`unexpected ${COMPOSITE} definition`);
  }
  return def.slice('CHECK '.length);
};

const widenComposite = (expression) => {
  if (!expression.includes(`${COLUMN} IS NOT NULL`)) {
    throw new Error(`unexpected ${COMPOSITE} shape`);
  }
  return expression
    .replaceAll(
      `${COLUMN} IS NOT NULL`,
      `(${COLUMN} IS NOT NULL OR ${TEXT_COLUMN} IS NOT NULL)`,
    )
    .replaceAll(
      `${COLUMN} IS NULL`,
      `(${COLUMN} IS NULL AND ${TEXT_COLUMN} IS NULL)`,
    );
};

const narrowComposite = (expression) => {
  // PostgreSQL deparses the widened expression with individually
  // parenthesized operands; accept both that shape and the exact shape
  // widenComposite inserted, and refuse any other shape.
  const legacy = expression
    .replace(
      /\(\s*\(\s*capability_key_version IS NOT NULL\s*\)\s+OR\s+\(\s*capability_key_version_text IS NOT NULL\s*\)\s*\)/g,
      'capability_key_version IS NOT NULL',
    )
    .replace(
      /\(\s*\(\s*capability_key_version IS NULL\s*\)\s+AND\s+\(\s*capability_key_version_text IS NULL\s*\)\s*\)/g,
      'capability_key_version IS NULL',
    )
    .replaceAll(
      `(${COLUMN} IS NOT NULL OR ${TEXT_COLUMN} IS NOT NULL)`,
      `${COLUMN} IS NOT NULL`,
    )
    .replaceAll(
      `(${COLUMN} IS NULL AND ${TEXT_COLUMN} IS NULL)`,
      `${COLUMN} IS NULL`,
    );
  if (legacy === expression) {
    throw new Error(`unexpected ${COMPOSITE} shape`);
  }
  return legacy;
};

exports.up = async (pgm) => {
  // Capture the tracked legacy-only composite before any queued DDL runs.
  const widened = `CHECK (${widenComposite(await compositeExpression(pgm.db))})`;
  pgm.addColumns(TABLE, { [TEXT_COLUMN]: { type: 'text' } });
  pgm.addConstraint(
    TABLE,
    TEXT_CHECK,
    `CHECK (${TEXT_COLUMN} IS NULL OR ${TEXT_COLUMN} ~ '${CANONICAL}')`,
  );
  // Queued backfill: runs after the column exists, lossless for the
  // positive integers the legacy check has always enforced.
  pgm.sql(
    `UPDATE ${TABLE} SET ${TEXT_COLUMN} = ${COLUMN}::text
     WHERE ${COLUMN} IS NOT NULL`,
  );
  pgm.dropConstraint(TABLE, COMPOSITE);
  pgm.addConstraint(TABLE, COMPOSITE, widened);
};

exports.down = async (pgm) => {
  // Capture the widened composite immediately (pre-DDL), then queue the
  // fail-closed guard and the data statements: the guard raises and aborts
  // before any later queued step touches the table, and the synchronize
  // update still sees the expand-phase text channel.
  const narrowed = `CHECK (${narrowComposite(await compositeExpression(pgm.db))})`;
  pgm.sql(
    `DO $guard$ DECLARE bad integer; BEGIN
       SELECT count(*) INTO bad FROM ${TABLE}
        WHERE ${TEXT_COLUMN} IS NOT NULL
          AND CASE WHEN ${TEXT_COLUMN} !~ '${CANONICAL}' THEN true
                   WHEN ${COLUMN} IS NOT NULL
                     AND ${COLUMN}::text <> ${TEXT_COLUMN} THEN true
                   WHEN length(${TEXT_COLUMN}) > 10 THEN true
                   WHEN length(${TEXT_COLUMN}) = 10
                     AND ${TEXT_COLUMN} > '${MAX_INT32}' THEN true
                   ELSE false END;
       IF bad > 0 THEN
         RAISE EXCEPTION 'refusing to roll back capability string versions: canonical text is non-canonical, diverges from legacy evidence, or exceeds the legacy signed int32 range';
       END IF;
     END $guard$;`,
  );
  pgm.sql(
    `UPDATE ${TABLE} SET ${COLUMN} = ${TEXT_COLUMN}::integer
     WHERE ${TEXT_COLUMN} IS NOT NULL AND ${COLUMN} IS NULL`,
  );
  pgm.dropConstraint(TABLE, TEXT_CHECK);
  pgm.dropConstraint(TABLE, COMPOSITE);
  pgm.addConstraint(TABLE, COMPOSITE, narrowed);
  pgm.dropColumns(TABLE, TEXT_COLUMN);
};
