import { z } from 'zod';

/**
 * Restock backorder («pedido por reposición»), bot side of
 * docs/contracts/restock-backorder-bot-contract.md (backend T1).
 *
 * A separate port from `ChatbotApiClient` so the existing fakes of that
 * client stay valid. Timestamps are UTC with `Z`; the customer copy converts
 * them to America/Mexico_City.
 */
export const BACKORDER_CLIENT = Symbol('BACKORDER_CLIENT');

/** Stable error codes of `POST /chatbot-api/backorders` the bot reacts to. */
export const BACKORDER_ERROR = Object.freeze({
  STOCK_AVAILABLE_NOW: 'STOCK_AVAILABLE_NOW',
  BACKORDER_DUPLICATE: 'BACKORDER_DUPLICATE',
  BACKORDER_NOT_FOUND: 'BACKORDER_NOT_FOUND',
  BACKORDER_NOT_CANCELLABLE: 'BACKORDER_NOT_CANCELLABLE',
  IDEMPOTENCY_KEY_IN_FLIGHT: 'IDEMPOTENCY_KEY_IN_FLIGHT',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  BACKORDER_RETRY_REQUIRED: 'BACKORDER_RETRY_REQUIRED',
  CUSTOMER_PHONE_AMBIGUOUS: 'CUSTOMER_PHONE_AMBIGUOUS',
} as const);

export const BACKORDER_STATUSES = [
  'WAITING',
  'RESERVED',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type BackorderStatus = (typeof BACKORDER_STATUSES)[number];

const instant = z.iso.datetime({ offset: true });
const nullableText = z.string().nullable();
const nullableInstant = instant.nullable();
const nullableCents = z.number().int().nonnegative().nullable();

/** Unknown keys are stripped: the backend adds fields over time. */
const backorderSchema = z.object({
  id: z.string().min(1),
  folio: z.string().min(1),
  status: z.enum(BACKORDER_STATUSES),
  productId: z.string().min(1),
  productName: z.string().min(1),
  variantId: nullableText,
  variantName: nullableText,
  quantity: z.number().int().min(1),
  referencePriceCents: z.number().int().nonnegative(),
  currentPriceCents: nullableCents,
  finalPriceCents: nullableCents,
  scheduledAt: instant,
  estimatedAt: instant,
  estimatedArrivalDays: z.number().int().nonnegative().nullable(),
  reservedAt: nullableInstant,
  reservedUntil: nullableInstant,
  reminderAt: nullableInstant,
  queuePosition: z.number().int().positive().nullable(),
  saleId: nullableText,
  cancelledByKind: nullableText,
  cancelReason: nullableText,
  branchName: nullableText,
  customerFirstName: nullableText,
});

export type BackorderBot = z.infer<typeof backorderSchema>;

/** The `{ backorder }` envelope of POST / GET :id / cancel, or `null`. */
export function parseBackorderEnvelope(body: unknown): BackorderBot | null {
  if (typeof body !== 'object' || body === null) return null;
  const parsed = backorderSchema.safeParse(
    (body as { backorder?: unknown }).backorder,
  );
  return parsed.success ? parsed.data : null;
}

/** The `{ items }` envelope of the list, or `null` when any item is invalid. */
export function parseBackorderList(body: unknown): BackorderBot[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out: BackorderBot[] = [];
  for (const item of items) {
    const parsed = backorderSchema.safeParse(item);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

export type BackorderCustomerInput =
  | { mode: 'existing'; customerId: string }
  | { mode: 'createIfAbsent'; firstName: string; lastName?: string };

export interface CreateBackorderInput {
  phoneCountryCode: string;
  phone: string;
  customer: BackorderCustomerInput;
  productId: string;
  variantId?: string | null;
  /** Whole units, ≥ 1. */
  quantity: number;
  /** Omitted by the bot: the server computes the reference price. */
  expectedReferencePriceCents?: number;
  sourceDecisionId: string;
  chatbotRequestId?: string | null;
}

export interface CreateBackorderResult {
  /** `true` for 201 (new), `false` for 200 (same key replayed). */
  created: boolean;
  backorder: BackorderBot;
}

export interface ListBackordersQuery {
  phoneCountryCode?: string;
  phone?: string;
  /** Comma list, e.g. `WAITING,RESERVED`. */
  status?: string;
  /** ISO instant with zone. */
  updatedSince?: string;
}

export interface BackorderClient {
  /** `POST /chatbot-api/backorders` (scope `backorders:create`). */
  createBackorder(
    input: CreateBackorderInput,
    idempotencyKey: string,
  ): Promise<CreateBackorderResult>;
  /** `GET /chatbot-api/backorders/:id` (scope `backorders:read`). */
  getBackorder(id: string): Promise<BackorderBot>;
  /** `GET /chatbot-api/backorders` (scope `backorders:read`), max 50. */
  listBackorders(query?: ListBackordersQuery): Promise<BackorderBot[]>;
  /** `POST /chatbot-api/backorders/:id/cancel` (scope `backorders:cancel`). */
  cancelBackorder(id: string, reason?: string): Promise<BackorderBot>;
}

/** The estimate date the backend derives: `resolvedAt + restockDays`. */
export function backorderEstimatedAt(
  resolvedAt: string,
  restockDays: number,
): string | null {
  const base = Date.parse(resolvedAt);
  if (!Number.isFinite(base) || !Number.isInteger(restockDays)) return null;
  const at = new Date(base + restockDays * 86_400_000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Stable per offer: a retry of the same offer replays the same backorder. */
export function backorderIdempotencyKey(
  decisionId: string,
  senderId: string,
): string {
  return `backorder:${decisionId}:${senderId}`;
}
