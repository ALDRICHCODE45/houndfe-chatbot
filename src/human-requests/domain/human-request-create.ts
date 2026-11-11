import { createHash } from 'node:crypto';
import {
  HUMAN_REQUEST_SUMMARY_MAX_LENGTH,
  type CreateDirectHumanRequestInput,
  type HumanRequestContext,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';

/**
 * UNKNOWN_QUESTION create path (S6, docs/human-request-feed.md): the pure
 * envelope rules and the fixed customer copy. Customer copy is usted; the
 * tú variants are curated pairs in `customer-style.ts`.
 */

export const ASK_TEAM_REGISTERED_REPLY =
  'Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan.';
export const ASK_TEAM_OPEN_LIMIT_REPLY =
  'Ya tiene varias consultas abiertas con el equipo; en cuanto respondan le aviso por aquí.';
export const ASK_TEAM_RATE_LIMITED_REPLY =
  'El equipo ya tiene sus consultas recientes; por favor espere un poco antes de enviar otra.';
/** Queued for a retry: never claims the team was asked. */
export const ASK_TEAM_QUEUED_REPLY =
  'Estoy registrando su consulta con el equipo; le aviso por aquí.';

export const ASK_TEAM_QUESTION_MAX_LENGTH = 1000;
const CONTEXT_MAX_IDS = 20;
const DEDUP_HASH_LENGTH = 24;
/** Backend bounds for `lastCustomerMessageAt`. */
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface UnknownQuestionInput {
  /** Raw Meta wa_id. */
  senderId: string;
  /** The customer's question in their own words. */
  question: string;
  /** One-line Spanish summary for staff. */
  summary: string;
  productIds?: readonly string[];
  variantIds?: readonly string[];
  /** The triggering inbound's time; `now` when absent or out of bounds. */
  inboundAt?: string | null;
  triggerWaMessageId?: string | null;
}

/** Lowercase, NFKC, whitespace collapsed: case/spacing variants match. */
export function normalizeQuestion(question: string): string {
  return question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function unknownQuestionDedupKey(question: string): string {
  const digest = createHash('sha256')
    .update(normalizeQuestion(question), 'utf8')
    .digest('hex');
  return `UNKNOWN_QUESTION:${digest.slice(0, DEDUP_HASH_LENGTH)}`;
}

function lastMessageAt(inboundAt: string | null | undefined, now: Date) {
  const at = typeof inboundAt === 'string' ? Date.parse(inboundAt) : NaN;
  const nowMs = now.getTime();
  return Number.isNaN(at) ||
    at > nowMs + MAX_FUTURE_MS ||
    at < nowMs - MAX_AGE_MS
    ? now.toISOString()
    : new Date(at).toISOString();
}

const boundedIds = (ids: readonly string[] | undefined): string[] =>
  [...new Set(ids ?? [])].slice(0, CONTEXT_MAX_IDS);

/** The create body, or null when the sender or the texts are unusable. */
export function buildUnknownQuestionRequest(
  input: UnknownQuestionInput,
  options: { sourceRequestId: string; now: Date },
): CreateDirectHumanRequestInput | null {
  const phone = parseMexicanWhatsAppPhone(input.senderId);
  const question = input.question.trim().slice(0, ASK_TEAM_QUESTION_MAX_LENGTH);
  const summary = input.summary
    .trim()
    .slice(0, HUMAN_REQUEST_SUMMARY_MAX_LENGTH);
  if (phone === null || question === '' || summary === '') return null;
  const productIds = boundedIds(input.productIds);
  const variantIds = boundedIds(input.variantIds);
  const context: HumanRequestContext = {
    ...(productIds.length === 0 ? {} : { productIds }),
    ...(variantIds.length === 0 ? {} : { variantIds }),
  };
  const trigger = input.triggerWaMessageId;
  return {
    sourceRequestId: options.sourceRequestId,
    subtype: 'UNKNOWN_QUESTION',
    customer: {
      phoneCountryCode: phone.phoneCountryCode,
      phone: phone.phone,
    },
    conversationRef: conversationRefFor(input.senderId),
    lastCustomerMessageAt: lastMessageAt(input.inboundAt, options.now),
    summary,
    needs: question,
    ...(Object.keys(context).length === 0 ? {} : { context }),
    dedupKey: unknownQuestionDedupKey(question),
    ...(typeof trigger === 'string' && trigger !== ''
      ? { triggerWaMessageId: trigger }
      : {}),
  };
}
