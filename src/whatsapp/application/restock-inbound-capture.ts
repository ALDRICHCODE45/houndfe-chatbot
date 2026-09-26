import {
  bindRestockInboundEvidence,
  normalizeRestockInboundEvidence,
  type RestockInboundEvidence,
} from '../../human-decisions/domain/restock-inbound-evidence';
import type { RestockInboundEvidencePort } from '../../human-decisions/infrastructure/postgres-restock-inbound-evidence.store';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import type { VerifiedWebhookSnapshot } from '../presentation/signature.guard';

type Result =
  | { action: 'disabled' | 'hold' }
  | {
      action: 'captured';
      event: WebhookEventDto;
      evidence: readonly RestockInboundEvidence[];
    };
const HOLD = { action: 'hold' } as const;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * UNWIRED text-only demo. Cannot authenticate caller-made snapshots: a future
 * controller MUST use the private SignatureGuard getter, never @Body authority.
 * The parsed event is fresh, not deep-frozen; its future consumer owns it locally.
 * Captured grants no dispatch/send permission. A stored prefix can survive failure;
 * retry uses store replay, not batch transactions or generalized rejection isolation.
 */
export class RestockInboundCapture {
  constructor(
    private readonly enabled: unknown,
    private readonly phone: string,
    private readonly store: Pick<RestockInboundEvidencePort, 'record'>,
    private readonly isOpsSender: (senderId: string) => boolean,
    private readonly isKnownOutbound: (messageId: string) => boolean,
  ) {}
  async capture(snapshot: VerifiedWebhookSnapshot | null): Promise<Result> {
    if (this.enabled !== true) return { action: 'disabled' };
    if (!snapshot) return HOLD;
    const { rawBodyBase64, observedAt } = snapshot;
    let event: unknown;
    try {
      const bytes = Buffer.from(rawBodyBase64, 'base64');
      if (bytes.toString('base64') !== rawBodyBase64) return HOLD;
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) return HOLD;
      event = JSON.parse(text) as unknown;
    } catch {
      return HOLD;
    }
    if (
      !object(event) ||
      event.object !== 'whatsapp_business_account' ||
      !Array.isArray(event.entry)
    )
      return HOLD;
    const candidates: RestockInboundEvidence[] = [];
    for (const entry of event.entry) {
      if (!object(entry) || !Array.isArray(entry.changes)) return HOLD;
      for (const change of entry.changes) {
        if (
          !object(change) ||
          change.field !== 'messages' ||
          !object(change.value)
        )
          return HOLD;
        const value = change.value;
        if (!('messages' in value)) continue;
        if (!Array.isArray(value.messages)) return HOLD;
        for (const message of value.messages) {
          if (!object(message)) return HOLD;
          if (
            typeof message.id === 'string' &&
            this.isKnownOutbound(message.id)
          )
            continue;
          if (
            typeof message.from === 'string' &&
            this.isOpsSender(message.from)
          )
            continue;
          if (
            message.type !== 'text' ||
            !object(message.text) ||
            typeof message.text.body !== 'string' ||
            typeof message.from !== 'string' ||
            [
              'image',
              'document',
              'audio',
              'video',
              'sticker',
              'location',
              'contacts',
              'interactive',
              'button',
              'reaction',
            ].some((key) => key in message)
          )
            return HOLD;
          const candidate = bindRestockInboundEvidence(
            {
              event: {
                receivingPhoneNumberId: object(value.metadata)
                  ? value.metadata.phone_number_id
                  : undefined,
                senderId: message.from,
                messageId: message.id,
              },
              providerTimestampSeconds: message.timestamp,
              observedAt,
            },
            this.phone,
          );
          if (!candidate) return HOLD;
          candidates.push(candidate);
        }
      }
    }
    const evidence: RestockInboundEvidence[] = [];
    for (const candidate of candidates) {
      const result = await this.store.record(candidate);
      if (
        !object(result) ||
        (result.action !== 'recorded' && result.action !== 'replay')
      )
        return HOLD;
      const row = normalizeRestockInboundEvidence(result.evidence);
      if (
        !row ||
        Object.keys(candidate).some((key) => {
          const field = key as keyof RestockInboundEvidence;
          return field !== 'observedAt' && row[field] !== candidate[field];
        }) ||
        (result.action === 'recorded' &&
          row.observedAt !== candidate.observedAt)
      )
        return HOLD;
      evidence.push(row);
    }
    return {
      action: 'captured',
      event,
      evidence: Object.freeze(evidence),
    };
  }
}
