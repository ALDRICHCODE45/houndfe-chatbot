/**
 * S3: Meta delivery statuses (`entry[].changes[].value.statuses[]`) as the
 * bot forwards them to the backend outbox, one item per (wamid, status).
 */
export const META_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
export type MetaStatus = (typeof META_STATUSES)[number];

export interface MetaStatusUpdate {
  /** The outbound wamid the status refers to (`status.id`). */
  providerMessageId: string;
  /** Raw customer wa_id (`status.recipient_id`). */
  recipientWaId: string;
  status: MetaStatus;
  /** ISO-8601 UTC with ms and Z, from Meta's seconds timestamp. */
  occurredAt: string;
  /** First `errors[].code`, as a string (failed statuses). */
  errorCode?: string;
  errorTitle?: string;
}

export type IgnoredMetaStatusReason =
  | 'shape'
  | 'id'
  | 'status'
  | 'recipient'
  | 'timestamp';

export interface IgnoredMetaStatus {
  reason: IgnoredMetaStatusReason;
  providerMessageId?: string;
  status?: unknown;
}

export interface NormalizedMetaStatuses {
  statuses: MetaStatusUpdate[];
  /** Items left out, so the caller can log them. */
  ignored: IgnoredMetaStatus[];
}

const KNOWN: ReadonlySet<string> = new Set(META_STATUSES);
const WA_ID = /^[0-9]{6,20}$/;
const SECONDS = /^[0-9]{1,12}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Pure; reads only `statuses`, never `messages`. */
export function normalizeMetaStatuses(event: unknown): NormalizedMetaStatuses {
  const result: NormalizedMetaStatuses = { statuses: [], ignored: [] };
  if (!record(event)) return result;
  for (const entry of list(event.entry)) {
    if (!record(entry)) continue;
    for (const change of list(entry.changes)) {
      if (!record(change) || !record(change.value)) continue;
      for (const item of list(change.value.statuses)) {
        const outcome = normalizeOne(item);
        if ('reason' in outcome) result.ignored.push(outcome);
        else result.statuses.push(outcome);
      }
    }
  }
  return result;
}

function normalizeOne(item: unknown): MetaStatusUpdate | IgnoredMetaStatus {
  if (!record(item)) return { reason: 'shape' };
  const { id, status, recipient_id: recipient, timestamp } = item;
  if (typeof id !== 'string' || id.length < 1 || id.length > 256)
    return { reason: 'id', status };
  if (typeof status !== 'string' || !KNOWN.has(status))
    return { reason: 'status', providerMessageId: id, status };
  if (typeof recipient !== 'string' || !WA_ID.test(recipient))
    return { reason: 'recipient', providerMessageId: id, status };
  if (typeof timestamp !== 'string' || !SECONDS.test(timestamp))
    return { reason: 'timestamp', providerMessageId: id, status };
  const update: MetaStatusUpdate = {
    providerMessageId: id,
    recipientWaId: recipient,
    status: status as MetaStatus,
    occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
  };
  const error = list(item.errors)[0];
  if (record(error)) {
    if (typeof error.code === 'number' || typeof error.code === 'string')
      update.errorCode = String(error.code);
    if (typeof error.title === 'string' && error.title !== '')
      update.errorTitle = error.title;
  }
  return update;
}
