import {
  normalizeCustomerInboundObservation,
  type CustomerInboundObservation,
} from '../../human-decisions/domain/customer-inbound-observation';
import { readVerifiedWebhookSnapshot } from '../presentation/signature.guard';

export type CustomerInboundCaptureOptions = Readonly<{
  enabled: unknown;
  phone: string;
  isOpsSender: (senderId: string) => boolean;
  isKnownOutbound: (messageId: string) => boolean;
}>;
type Preparation =
  | Readonly<{ action: 'disabled' | 'hold' }>
  | Readonly<{
      action: 'prepared';
      observations: readonly CustomerInboundObservation[];
    }>;
const HOLD = Object.freeze({ action: 'hold' } as const);
const MESSAGE_TYPES = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** UNWIRED: reads the actual request's private, HMAC-verified snapshot only.
 * Requires trusted configuration/predicates; never validates message content.
 * Prepared metadata is not a capability, durable evidence, latestness or send
 * permission. A future persister must call this with the actual request itself.
 * The guard exposes snapshots when RESTOCK or customer inbound is enabled.
 */
export function prepareCustomerInboundObservations(
  request: unknown,
  options: CustomerInboundCaptureOptions,
): Preparation {
  if (options.enabled !== true) return Object.freeze({ action: 'disabled' });
  if (request === null || typeof request !== 'object') return HOLD;
  const snapshot = readVerifiedWebhookSnapshot(request);
  if (!snapshot) return HOLD;
  let event: unknown;
  try {
    const bytes = Buffer.from(snapshot.rawBodyBase64, 'base64');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return HOLD;
    event = JSON.parse(text) as unknown;
  } catch {
    return HOLD;
  }
  if (
    !record(event) ||
    event.object !== 'whatsapp_business_account' ||
    !Array.isArray(event.entry)
  )
    return HOLD;
  const observations: CustomerInboundObservation[] = [];
  for (const entry of event.entry) {
    if (!record(entry) || !Array.isArray(entry.changes)) return HOLD;
    for (const change of entry.changes) {
      if (!record(change)) return HOLD;
      if (change.field !== 'messages') continue;
      if (!record(change.value)) return HOLD;
      const value = change.value;
      if (!('messages' in value)) continue;
      if (
        !record(value.metadata) ||
        typeof value.metadata.phone_number_id !== 'string'
      )
        return HOLD;
      if (value.metadata.phone_number_id !== options.phone) continue;
      if (!Array.isArray(value.messages)) return HOLD;
      for (const message of value.messages) {
        if (!record(message)) return HOLD;
        if (
          typeof message.type !== 'string' ||
          !MESSAGE_TYPES.has(message.type)
        )
          continue;
        if (
          (typeof message.from === 'string' &&
            options.isOpsSender(message.from)) ||
          (typeof message.id === 'string' &&
            options.isKnownOutbound(message.id))
        )
          continue;
        const observation = normalizeCustomerInboundObservation({
          senderId: message.from,
          receivingPhoneNumberId: value.metadata.phone_number_id,
          messageId: message.id,
          providerTimestampSeconds: message.timestamp,
          observedAt: snapshot.observedAt,
        });
        if (!observation) return HOLD;
        observations.push(observation);
      }
    }
  }
  return Object.freeze({
    action: 'prepared',
    observations: Object.freeze(observations),
  });
}
