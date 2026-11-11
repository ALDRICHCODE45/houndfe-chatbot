/**
 * Backend outbox ordering lanes: strict order is kept per
 * (conversation_ref, lane) instead of per conversation, so request
 * creates/cancels never wait behind transcript rows that keep retrying.
 *
 *   - MIRROR: MESSAGE_MIRROR, MESSAGE_STATUS (transcript order).
 *   - CONTROL: REQUEST_CREATE, REQUEST_CANCEL, SESSION_ACK, DELIVERY_OUTCOME.
 *
 * The lane is derived from the kind (`laneForKind` in
 * src/backend-outbox/domain/backend-outbox.ts) and a CHECK rejects a lane
 * that does not match. `backend_outbox_sequences` is keyed by
 * (conversation_ref, lane); every existing counter is copied to both lanes
 * so no seq already handed out is ever reused in either lane.
 *
 * `down` locks the tables and refuses while backend_outbox has rows (as
 * 3900 does): seqs of both lanes would collide once collapsed. Counters are
 * collapsed to the highest lane counter per conversation.
 */
const TABLE = 'backend_outbox';
const SEQUENCES = 'backend_outbox_sequences';
const MIRROR_KINDS = "'MESSAGE_MIRROR', 'MESSAGE_STATUS'";
const LANE_OF_KIND = `CASE WHEN kind IN (${MIRROR_KINDS}) THEN 'MIRROR' ELSE 'CONTROL' END`;
const LANES = "lane IN ('MIRROR', 'CONTROL')";

exports.up = (pgm) => {
  pgm.sql(`LOCK TABLE ${TABLE}, ${SEQUENCES} IN ACCESS EXCLUSIVE MODE;`);

  pgm.addColumn(SEQUENCES, {
    lane: { type: 'text', notNull: true, default: 'MIRROR' },
  });
  pgm.alterColumn(SEQUENCES, 'lane', { default: null });
  pgm.dropConstraint(SEQUENCES, `${SEQUENCES}_pkey`);
  pgm.addConstraint(SEQUENCES, `${SEQUENCES}_pkey`, {
    primaryKey: ['conversation_ref', 'lane'],
  });
  pgm.sql(
    `INSERT INTO ${SEQUENCES} (conversation_ref, lane, next_seq)
     SELECT conversation_ref, 'CONTROL', next_seq FROM ${SEQUENCES};`,
  );
  pgm.addConstraint(SEQUENCES, `${SEQUENCES}_lane_check`, `CHECK (${LANES})`);

  pgm.addColumn(TABLE, { lane: { type: 'text' } });
  pgm.sql(`UPDATE ${TABLE} SET lane = ${LANE_OF_KIND};`);
  pgm.alterColumn(TABLE, 'lane', { notNull: true });
  pgm.addConstraint(
    TABLE,
    `${TABLE}_lane_check`,
    `CHECK (${LANES} AND lane = ${LANE_OF_KIND})`,
  );
  pgm.dropConstraint(TABLE, `${TABLE}_conversation_seq_key`);
  pgm.addConstraint(TABLE, `${TABLE}_conversation_lane_seq_key`, {
    unique: ['conversation_ref', 'lane', 'seq'],
  });

  // Head lookup for claiming: open rows per (conversation, lane) in seq order.
  pgm.dropIndex(TABLE, [], { name: `${TABLE}_open_heads_idx` });
  pgm.createIndex(TABLE, ['conversation_ref', 'lane', 'seq'], {
    name: `${TABLE}_open_heads_idx`,
    where: "status IN ('PENDING', 'IN_FLIGHT')",
  });
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${TABLE}, ${SEQUENCES} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE} lanes: table is non-empty';
       END IF;
     END $guard$;`,
  );

  pgm.dropIndex(TABLE, [], { name: `${TABLE}_open_heads_idx` });
  pgm.dropConstraint(TABLE, `${TABLE}_conversation_lane_seq_key`);
  pgm.dropConstraint(TABLE, `${TABLE}_lane_check`);
  pgm.dropColumn(TABLE, 'lane');
  pgm.addConstraint(TABLE, `${TABLE}_conversation_seq_key`, {
    unique: ['conversation_ref', 'seq'],
  });
  pgm.createIndex(TABLE, ['conversation_ref', 'seq'], {
    name: `${TABLE}_open_heads_idx`,
    where: "status IN ('PENDING', 'IN_FLIGHT')",
  });

  // Keep the highest counter per conversation so no seq is reused.
  pgm.sql(
    `DELETE FROM ${SEQUENCES} s USING ${SEQUENCES} o
      WHERE s.conversation_ref = o.conversation_ref
        AND (s.next_seq < o.next_seq
             OR (s.next_seq = o.next_seq AND s.lane > o.lane));`,
  );
  pgm.dropConstraint(SEQUENCES, `${SEQUENCES}_lane_check`);
  pgm.dropConstraint(SEQUENCES, `${SEQUENCES}_pkey`);
  pgm.dropColumn(SEQUENCES, 'lane');
  pgm.addConstraint(SEQUENCES, `${SEQUENCES}_pkey`, {
    primaryKey: ['conversation_ref'],
  });
};
