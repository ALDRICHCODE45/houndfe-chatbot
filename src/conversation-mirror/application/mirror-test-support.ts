import type { BackendOutboxEntry } from '../../backend-outbox/domain/backend-outbox';

/** Shared builders for the mirror delivery specs (not production code). */
export const REF = 'wa:5215550001111';
export const NOW = new Date('2026-11-12T17:00:00.000Z');
export const MEDIA_ID = '0b3f1c1e-aaaa-4bbb-8ccc-000000000001';
export const MEDIA_ID_2 = '0b3f1c1e-aaaa-4bbb-8ccc-000000000002';

export const rowEntry = (
  seq: number,
  payload: Record<string, unknown>,
  kind: BackendOutboxEntry['kind'] = 'MESSAGE_MIRROR',
  overrides: Partial<BackendOutboxEntry> = {},
): BackendOutboxEntry => ({
  id: String(seq),
  conversationRef: REF,
  seq,
  kind,
  idempotencyKey: `${kind === 'MESSAGE_MIRROR' ? 'mirror' : 'status'}:${seq}`,
  payload,
  status: 'IN_FLIGHT',
  attempts: 0,
  nextAttemptAt: NOW,
  leaseOwner: 'o',
  leaseExpiresAt: NOW,
  lastError: null,
  createdAt: new Date('2026-11-12T16:30:00.000Z'),
  doneAt: null,
  ...overrides,
});

export const textPayload = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  waMessageId: id,
  direction: 'IN',
  author: 'CUSTOMER',
  type: 'text',
  contractType: 'TEXT',
  text: `texto ${id}`,
  providerTimestamp: '2026-11-12T16:02:11.000Z',
  observedAt: '2026-11-12T16:02:12.103Z',
  ...overrides,
});

export const imagePayload = (
  id: string,
  providerMediaId = `meta-${id}`,
): Record<string, unknown> =>
  textPayload(id, {
    type: 'image',
    contractType: 'IMAGE',
    text: 'mi foto',
    media: { providerMediaId, mimeType: 'image/jpeg' },
  });

export const okAck = (
  messages: ReadonlyArray<{ waMessageId: string }>,
  duplicates: string[] = [],
) => ({
  kind: 'ok' as const,
  accepted: messages
    .filter((m) => !duplicates.includes(m.waMessageId))
    .map((m, index) => ({
      waMessageId: m.waMessageId,
      messageId: `id-${index}`,
      seq: index + 1,
    })),
  duplicates,
});
