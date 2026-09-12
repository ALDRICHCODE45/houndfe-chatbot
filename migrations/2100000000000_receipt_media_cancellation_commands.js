/** Durable provenance for one immutable receipt-cancellation command. */
const TABLE = 'receipt_media_cancellation_commands';

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    receipt_media_id: {
      type: 'uuid',
      primaryKey: true,
      notNull: true,
      references: 'receipt_media(id)',
      onDelete: 'RESTRICT',
    },
    source_webhook_message_id: { type: 'text', notNull: true },
    sender_id: { type: 'text', notNull: true },
    captured_sale_id: { type: 'uuid', notNull: true },
    expected_receipt_status: { type: 'text', notNull: true },
    expected_receipt_version: { type: 'bigint', notNull: true },
    expected_pointer_receipt_media_id: { type: 'uuid', notNull: true },
    expected_pointer_sale_id: { type: 'uuid', notNull: true },
    expected_pointer_receipt_version: { type: 'bigint', notNull: true },
    successor_receipt_version: { type: 'bigint', notNull: true },
    cancellation_outbox_id: {
      type: 'uuid',
      notNull: true,
      references: 'receipt_media_outbox(id)',
      onDelete: 'RESTRICT',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint(
    TABLE,
    'receipt_media_cancellation_commands_sender_webhook_key',
    'UNIQUE (sender_id, source_webhook_message_id)',
  );
  pgm.addConstraint(
    TABLE,
    'receipt_media_cancellation_commands_identity_check',
    "CHECK (expected_receipt_status IN ('AWAITING_AMOUNT', 'AWAITING_CONFIRMATION') AND expected_receipt_version BETWEEN 1 AND 9223372036854775806 AND expected_pointer_receipt_media_id = receipt_media_id AND expected_pointer_sale_id = captured_sale_id AND expected_pointer_receipt_version = expected_receipt_version AND successor_receipt_version = expected_receipt_version + 1)",
  );
};

exports.down = async (pgm) => {
  const { rows } = await pgm.db.query(
    `SELECT EXISTS (SELECT 1 FROM ${TABLE}) AS commands`,
  );
  if (rows[0].commands)
    throw new Error(
      'refusing to roll back receipt cancellation provenance: table is non-empty',
    );
  pgm.dropTable(TABLE);
};
