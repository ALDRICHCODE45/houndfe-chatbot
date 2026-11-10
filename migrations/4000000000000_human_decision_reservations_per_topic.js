/**
 * S5 several open human requests per customer: replace the 230 partial unique
 * index (one ACTIVE reservation per sender across every route) with one ACTIVE
 * reservation per (sender_id, route, topic_key).
 *
 * `topic_key` names the subject of the request: `legacy` for LEGACY_OPS (one
 * per sender while that channel is retired), otherwise `variant:<uuid>` when
 * the intake names a variant, else `product:<uuid>`, both lowercased (a
 * malformed intake yields a non-null placeholder so the intake CHECKs, not the
 * NOT NULL, report it). It is a
 * STORED generated column, so existing rows are backfilled by the ADD COLUMN
 * and no writer can alias two subjects. `reservationTopicKey` in
 * `shared-reservation.ts` mirrors the expression for lookups. The total cap of
 * 20 ACTIVE reservations per sender lives in the application layer.
 *
 * `down` locks the table and refuses while any sender holds more than one
 * ACTIVE reservation (the old index could not hold them); it never closes or
 * deletes a row.
 */
const TABLE = 'human_decision_reservations';
const SENDER_INDEX = 'human_decision_reservations_active_sender_idx';
const TOPIC_INDEX = 'human_decision_reservations_active_topic_idx';
const ACTIVE = "status = 'ACTIVE'";
const DERIVED_TOPIC = `CASE WHEN route = 'LEGACY_OPS' THEN 'legacy'
  WHEN intake ->> 'variantId' IS NOT NULL THEN 'variant:' || lower(intake ->> 'variantId')
  ELSE 'product:' || COALESCE(lower(intake ->> 'productId'), '') END`;

exports.up = (pgm) => {
  pgm.sql(
    `ALTER TABLE ${TABLE} ADD COLUMN topic_key text NOT NULL
       GENERATED ALWAYS AS (${DERIVED_TOPIC}) STORED`,
  );
  pgm.dropIndex(TABLE, 'sender_id', { name: SENDER_INDEX });
  pgm.createIndex(TABLE, ['sender_id', 'route', 'topic_key'], {
    name: TOPIC_INDEX,
    unique: true,
    where: ACTIVE,
  });
};

exports.down = (pgm) => {
  // Normal node-pg-migrate transaction holds this lock through guard + rewrite.
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${TABLE} WHERE ${ACTIVE}
         GROUP BY sender_id HAVING count(*) > 1
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${TOPIC_INDEX}: a sender holds more than one ACTIVE reservation';
       END IF;
     END $guard$;`,
  );
  pgm.dropIndex(TABLE, ['sender_id', 'route', 'topic_key'], {
    name: TOPIC_INDEX,
  });
  pgm.createIndex(TABLE, 'sender_id', {
    name: SENDER_INDEX,
    unique: true,
    where: ACTIVE,
  });
  pgm.dropColumn(TABLE, 'topic_key');
};
