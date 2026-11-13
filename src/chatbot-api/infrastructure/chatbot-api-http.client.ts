import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { lastValueFrom } from 'rxjs';
import type { AppConfig } from '../../config/configuration';
import type {
  ChatbotApiClient,
  HumanRequestsClient,
} from '../domain/chatbot-api.client';
import type { AttachReceiptTransportOptions } from '../domain/chatbot-api.client';
import type { ConversationMirrorClient } from '../domain/conversation-mirror.port';
import type { LiveConversationClient } from '../domain/live-conversation.port';
import type { SchedulingClient } from '../domain/scheduling.port';
import {
  isSchedulingIdempotencyKey,
  listSlotsProblem,
  parseAlreadyScheduled,
  parseRescheduleOk,
  parseSlotUnavailable,
  parseSlotsAnswer,
  rescheduleProblem,
  toRescheduleBody,
  type ListSlotsInput,
  type ListSlotsResult,
  type RescheduleRequestInput,
  type RescheduleRequestResult,
} from '../domain/dtos/scheduling.dto';
import {
  STAFF_MEDIA_MAX_BYTES,
  UNKNOWN_CONVERSATION_STATE,
  isStaffMediaId,
  isStaffMediaMimeType,
  listHumanConversationsProblem,
  parseConversationState,
  parseHumanConversationList,
  parseSessionAckOk,
  parseStaleEpoch,
  sessionAckProblem,
  toSessionAckBody,
  type DownloadStaffMediaOptions,
  type DownloadStaffMediaResult,
  type GetConversationStateResult,
  type ListHumanConversationsOptions,
  type ListHumanConversationsResult,
  type SessionAckInput,
  type SessionAckResult,
} from '../domain/dtos/live-conversation.dto';
import {
  MEDIA_MAX_BYTES,
  MIRROR_CONVERSATION_REF_MAX_CHARS,
  createMediaMultipart,
  isLowercaseUuid,
  isSha256Hex,
  isValidConversationRef,
  localValidation,
  parseMirrorBatchAck,
  parseMirrorStatusAck,
  parseUploadedMedia,
  safeMediaFilename,
  toMirrorMessagesBody,
  toMirrorStatusesBody,
  validateMirrorMessages,
  validateMirrorStatuses,
  type ConversationMirrorCommonFailure,
  type MirrorMessageInput,
  type MirrorMessagesResult,
  type MirrorStatusInput,
  type MirrorStatusesResult,
  type UploadMediaInput,
  type UploadMediaResult,
} from '../domain/dtos/conversation-mirror.dto';
import {
  parseCatalogSearchResponse,
  parseStockCheckResponse,
} from '../domain/dtos/catalog.dto';
import type {
  CatalogItemResponse,
  StockCheckResponse,
} from '../domain/dtos/catalog.dto';
import type { TolerantRead } from '../domain/dtos/tolerant-read';
import type {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from '../domain/dtos/customers.dto';
import {
  isDigitCheckoutCountryCode,
  isDigitCheckoutPhone,
  normalizeCheckoutContextQuery,
  normalizeCustomerCheckoutContext,
} from '../domain/dtos/checkout-context.dto';
import type {
  CheckoutContextQuery,
  CustomerCheckoutContext,
} from '../domain/dtos/checkout-context.dto';
import {
  CheckoutIdempotencyKeySchema,
  CreateCheckoutInputSchema,
  normalizeCheckoutResponse,
  normalizeCheckoutStatus,
  type CreateCheckoutInput,
  type CheckoutResponse,
  type CheckoutStatus,
} from '../domain/dtos/checkout.dto';
import type { PaymentDetail } from '../domain/dtos/payment-details.dto';
import {
  isReceiptUploadResponse,
  RECEIPT_UPLOAD_ERROR,
  RECEIPT_UPLOAD_KEY_MAX_LENGTH,
  RECEIPT_UPLOAD_TIMEOUT_MS,
  toReceiptUploadForm,
  type ReceiptUploadFields,
  type ReceiptUploadFile,
  type ReceiptUploadResponse,
} from '../domain/dtos/receipt-upload.dto';
import {
  parseReceiptOutcome,
  type ReceiptOutcome,
} from '../domain/dtos/receipt-outcome.dto';
import {
  CreateShippingQuoteInputSchema,
  normalizeShippingQuoteResponse,
  type CreateShippingQuoteInput,
  type ShippingQuoteResponse,
} from '../domain/dtos/shipping-quote.dto';
import { parseCartEvaluationResult } from '../domain/dtos/pricing.dto';
import type {
  CartEvaluationResult,
  CartItemInput,
} from '../domain/dtos/pricing.dto';
import type {
  BotSaleResponse,
  CancelSaleInput,
  CancelSaleResult,
  CreateSaleInput,
  OrderHistoryResponse,
  UpdateDeliveryInput,
} from '../domain/dtos/sales.dto';
import {
  CancelSaleInputSchema,
  CreateSaleInputSchema,
  parseOrderHistoryResponse,
} from '../domain/dtos/sales.dto';
import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from '../domain/dtos/human-decisions-expiration.dto';
import {
  normalizeExpirationDecision,
  type ExpirationDecision,
} from '../domain/dtos/human-decisions-expiration-decision.dto';
import {
  normalizeExpirationIntakeReceipt,
  type ExpirationIntakeReceipt,
} from '../domain/dtos/human-decisions-expiration-receipt.dto';
import {
  normalizeDeliveryZoneIntake,
  normalizeDeliveryZoneRequester,
  type DeliveryZoneIntakeInput,
  type DeliveryZoneRequester,
} from '../domain/dtos/human-decisions-delivery-zone.dto';
import {
  normalizeRestockApplicationOutcome,
  normalizeRestockApplicationOutcomeAck,
  normalizeRestockDecision,
  normalizeRestockIntake,
  normalizeRestockIntakeReceipt,
} from '../domain/dtos/human-decisions.dto';
import type {
  RestockApplicationOutcomeAck,
  RestockApplicationOutcomeRequest,
  RestockDecision,
  RestockIntakeInput,
  RestockIntakeReceipt,
} from '../domain/dtos/human-decisions.dto';
import {
  FEED_MAX_LIMIT,
  FEED_MAX_WAIT_SECONDS,
  OPEN_REQUESTS_MAX_LIMIT,
  isCanonicalUtcMs,
  isCreateHumanRequestInput,
  normalizeDeliveryOutcome,
  parseDeliveryOutcomeAck,
  parseFeedPage,
  parseHumanRequestCancelled,
  parseHumanRequestCreated,
  parseOpenRequestsPage,
  parsePendingDeliveries,
  toCreateHumanRequestBody,
  type CancelHumanRequestInput,
  type CancelHumanRequestResult,
  type CreateHumanRequestInput,
  type CreateHumanRequestResult,
  type DeliveryOutcomeInput,
  type ListOpenRequestsOptions,
  type ListOpenRequestsResult,
  type PendingDeliveriesFilter,
  type PendingDeliveriesResult,
  type ReadFeedOptions,
  type ReadFeedResult,
  type RecordDeliveryOutcomeResult,
} from '../domain/dtos/human-requests.dto';
import {
  AuthError,
  BranchMismatchError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../domain/errors';

type SleepFn = (milliseconds: number) => Promise<void>;

type RequestOptions = {
  branchId?: string;
  retryable?: boolean;
};

const MAX_GET_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 100;
/**
 * Per-request axios timeouts, so a hung backend never freezes a WhatsApp turn
 * or a poller. Each applies per attempt (a timed-out GET is retried under the
 * safe GET policy; a timed-out POST is single-attempt and an unknown outcome).
 * The slow routes sit above the backend's own deadlines: checkout/sales ≈30 s,
 * Skydropx quotes 30–35 s (≈16 s observed), receipt upload ≈60 s observed.
 */
export const CHATBOT_API_TIMEOUTS_MS = {
  default: 10_000,
  checkout: 30_000,
  shippingQuote: 45_000,
  receiptUpload: RECEIPT_UPLOAD_TIMEOUT_MS,
} as const;
/** Unit 9 timeouts, kept apart from `CHATBOT_API_TIMEOUTS_MS` (its shape is
 *  pinned by the timeouts spec): `messages:batch` / `statuses:batch` bodies
 *  reach a few MiB; a media upload streams up to 10 MiB between VPSs. */
export const CONVERSATION_MIRROR_TIMEOUTS_MS = {
  batch: 20_000,
  mediaUpload: 60_000,
} as const;
/** Unit 11 timeouts. `sessionAck` sits on the greeting path (the customer
 *  waits behind it), so it fails fast; the media download streams up to
 *  10 MiB between VPSs and is bounded as a whole. */
export const LIVE_CONVERSATION_TIMEOUTS_MS = {
  sessionAck: 10_000,
  read: 10_000,
  mediaDownload: 60_000,
} as const;
/** Unit 14 timeouts: both calls sit on the customer's reply path, and the
 *  backend answers in ~10–20 ms (p95), so they fail fast. */
export const SCHEDULING_TIMEOUTS_MS = {
  slots: 10_000,
  reschedule: 10_000,
} as const;
/** Largest error body read back from a failed streamed download. */
const STREAMED_ERROR_BODY_MAX_BYTES = 4096;
const STREAMED_ERROR_BODY_READ_MS = 2_000;
/** The feed long-poll timeout is `waitSeconds * 1000 + FEED_TIMEOUT_SLACK_MS`,
 *  so a healthy empty long-poll (25 s) never times out (≈35 s). */
export const FEED_TIMEOUT_SLACK_MS = 10_000;
const DECISION_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canonical lowercase RFC UUID v1–v8 with variant bits 8/9/a/b (nil uppercase/whitespace rejected). */
const EXPIRATION_DECISION_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CHATBOT_API_SLEEP = Symbol('CHATBOT_API_SLEEP');

@Injectable()
export class ChatbotApiHttpClient
  implements
    ChatbotApiClient,
    HumanRequestsClient,
    ConversationMirrorClient,
    LiveConversationClient,
    SchedulingClient
{
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CHATBOT_API_SLEEP)
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  async searchCatalog(
    q: string,
    limit?: number,
  ): Promise<CatalogItemResponse[]> {
    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: '/chatbot-api/catalog/search',
        params: {
          q,
          ...(limit === undefined ? {} : { limit }),
        },
      },
      { retryable: true },
    );
    return this.acceptTolerantRead(
      'catalog search',
      response,
      [200],
      parseCatalogSearchResponse(response.data),
    );
  }

  async getStock(productId: string): Promise<StockCheckResponse> {
    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: `/chatbot-api/catalog/${encodeURIComponent(productId)}/stock`,
      },
      { retryable: true },
    );
    return this.acceptTolerantRead(
      'stock check',
      response,
      [200],
      parseStockCheckResponse(response.data),
    );
  }

  async evaluateCart(
    items: CartItemInput[],
    customer?: { phoneCountryCode: string; phone: string },
  ): Promise<CartEvaluationResult> {
    const response = await this.requestWithResponse<unknown>({
      method: 'POST',
      url: '/chatbot-api/pricing/evaluate-cart',
      data: {
        items,
        ...(customer
          ? {
              phoneCountryCode: customer.phoneCountryCode,
              phone: customer.phone,
            }
          : {}),
      },
    });
    return this.acceptTolerantRead(
      'evaluate-cart',
      response,
      [200, 201],
      parseCartEvaluationResult(response.data),
    );
  }

  /** Unknown-key names already warned about, so each is logged only once. */
  private readonly loggedUnknownKeys = new Set<string>();

  /** Shared by the tolerant reads: an unexpected status or a body that
   *  breaks the contract is an UpstreamError; unknown keys were stripped and
   *  are warned once per name, never with values. */
  private acceptTolerantRead<T>(
    endpoint: string,
    response: AxiosResponse<unknown>,
    statuses: number[],
    parsed: TolerantRead<T> | null,
  ): T {
    if (!statuses.includes(response.status) || parsed === null) {
      throw new UpstreamError(
        `Chatbot API ${endpoint} response was invalid`,
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    for (const key of parsed.unknownKeys) {
      const name = `${endpoint}: ${key}`;
      if (this.loggedUnknownKeys.has(name)) continue;
      this.loggedUnknownKeys.add(name);
      new Logger(ChatbotApiHttpClient.name).warn(
        `Chatbot API ${endpoint} response carried an unknown key (stripped): ${key}`,
      );
    }
    return parsed.value;
  }

  getCustomerByPhone(
    cc: string,
    phone: string,
  ): Promise<CustomerLookupResponse> {
    return this.request<CustomerLookupResponse>(
      {
        method: 'GET',
        url: '/chatbot-api/customers/by-phone',
        params: {
          phoneCountryCode: cc,
          phone,
        },
      },
      { retryable: true },
    );
  }

  /**
   * `GET /chatbot-api/customers/checkout-context` (S6, scope
   * `customers:read`).
   *
   * The digit country code/phone and the page options are validated before any
   * request: an invalid limit is rejected, never clamped, and a malformed
   * cursor is refused locally. The safe GET retry policy (network/5xx only,
   * bounded to three attempts) and single-branch auth headers are reused. A
   * fulfilled HTTP 200 is accepted only when the strict envelope normalizer
   * returns one of `not_found`/`ambiguous`/`unique`; a malformed or truncated
   * body throws `UpstreamError` with status/body/`errorCode` evidence so the
   * lookup stays *unavailable* instead of being reported as absence. This is
   * read-only: no legacy customer lookup fallback or business write occurs.
   */
  async getCustomerCheckoutContext(
    cc: string,
    phone: string,
    options: CheckoutContextQuery = {},
  ): Promise<CustomerCheckoutContext> {
    if (!isDigitCheckoutCountryCode(cc) || !isDigitCheckoutPhone(phone)) {
      throw new ChatbotApiError(
        'Chatbot API checkout-context lookup received an invalid phone identity',
        null,
        undefined,
        null,
      );
    }

    const query = normalizeCheckoutContextQuery(options);
    if (query === null) {
      throw new ChatbotApiError(
        'Chatbot API checkout-context lookup received invalid query options',
        null,
        undefined,
        null,
      );
    }

    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: '/chatbot-api/customers/checkout-context',
        params: {
          phoneCountryCode: cc,
          phone,
          limit: query.limit,
          ...(query.afterAddressId === null
            ? {}
            : { afterAddressId: query.afterAddressId }),
        },
      },
      { retryable: true },
    );

    const body = response.data;
    const context = normalizeCustomerCheckoutContext(body);

    if (response.status !== 200 || context === null) {
      throw new UpstreamError(
        'Chatbot API checkout-context response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return context;
  }

  /** Atomic checkout POST is single-attempt; recovery is a separate GET. */
  async createCheckout(
    dto: CreateCheckoutInput,
    idempotencyKey: string,
  ): Promise<CheckoutResponse> {
    idempotencyKey = this.validateCheckoutKey(idempotencyKey);
    const parsed = CreateCheckoutInputSchema.safeParse(dto);
    if (!parsed.success) {
      throw new ChatbotApiError(
        'Invalid atomic checkout input',
        null,
        undefined,
        'INVALID_CHECKOUT_REQUEST',
      );
    }
    const data = parsed.data;
    const response = await this.requestWithResponse<unknown>({
      method: 'POST',
      url: '/chatbot-api/checkouts',
      data,
      headers: { 'X-Idempotency-Key': idempotencyKey },
      timeout: CHATBOT_API_TIMEOUTS_MS.checkout,
    });
    const checkout = normalizeCheckoutResponse(response.data);
    if (response.status !== 201 || checkout === null) {
      throw new UpstreamError(
        'Chatbot API checkout response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return checkout;
  }

  /** not_observed is not rollback evidence and never permits a fresh key. */
  async getCheckoutStatus(idempotencyKey: string): Promise<CheckoutStatus> {
    idempotencyKey = this.validateCheckoutKey(idempotencyKey);
    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: '/chatbot-api/checkouts/status',
        headers: { 'X-Idempotency-Key': idempotencyKey },
      },
      { retryable: true },
    );
    const status = normalizeCheckoutStatus(response.data);
    if (response.status !== 200 || status === null) {
      throw new UpstreamError(
        'Chatbot API checkout status response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    if (status.status === 'succeeded_unverified')
      new Logger(ChatbotApiHttpClient.name).warn(
        'chatbot-api /checkouts/status body has keys outside the contract; recovered the sale identity only',
      );
    return status;
  }

  /**
   * `POST /chatbot-api/shipping/quotes` is single-attempt (non-GET). The input
   * is validated before any request; only a 200/201 whose body passes the
   * strict normalizer resolves, otherwise `UpstreamError` keeps the evidence.
   */
  async createShippingQuote(
    input: CreateShippingQuoteInput,
  ): Promise<ShippingQuoteResponse> {
    const parsed = CreateShippingQuoteInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ChatbotApiError(
        'Invalid shipping quote input',
        null,
        undefined,
        'INVALID_SHIPPING_QUOTE_REQUEST',
      );
    }
    const response = await this.requestWithResponse<unknown>({
      method: 'POST',
      url: '/chatbot-api/shipping/quotes',
      data: parsed.data,
      timeout: CHATBOT_API_TIMEOUTS_MS.shippingQuote,
    });
    const quote = normalizeShippingQuoteResponse(response.data);
    if (
      (response.status !== 200 && response.status !== 201) ||
      quote === null
    ) {
      throw new UpstreamError(
        'Chatbot API shipping quote response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return quote;
  }

  private validateCheckoutKey(key: string): string {
    const parsed = CheckoutIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) {
      throw new ChatbotApiError(
        'Invalid checkout idempotency key',
        null,
        undefined,
        'INVALID_IDEMPOTENCY_KEY',
      );
    }
    return parsed.data;
  }

  upsertCustomer(dto: CustomerUpsertInput): Promise<CustomerUpsertResponse> {
    return this.request<CustomerUpsertResponse>({
      method: 'PUT',
      url: '/chatbot-api/customers/by-phone',
      data: dto,
    });
  }

  createSale(
    dto: CreateSaleInput,
    idempotencyKey: string,
  ): Promise<BotSaleResponse> {
    // Q2 / R13: validate `expectedTotalCents` before the request goes out.
    // The schema accepts `null | undefined | non-negative integer`; the wire
    // strips absent values so the JSON body never carries the key (no `0`,
    // no `null` to mean "absent").
    const parsed = CreateSaleInputSchema.parse(dto);
    const expectedTotalCents = parsed.expectedTotalCents;
    const wireDto: CreateSaleInput = {
      cashierUserId: parsed.cashierUserId,
      customerId: parsed.customerId,
      shippingAddressId: parsed.shippingAddressId ?? null,
      items: parsed.items,
      ...(typeof expectedTotalCents === 'number' ? { expectedTotalCents } : {}),
    };
    return this.request<BotSaleResponse>({
      method: 'POST',
      url: '/chatbot-api/sales',
      data: wireDto,
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
      timeout: CHATBOT_API_TIMEOUTS_MS.checkout,
    }).then((sale) => this.normalizeSaleResponse(sale));
  }

  /**
   * Normalize the resolved `BotSaleResponse`: default `discountCents` to `0`
   * when the body omits it (legacy backend). Emits a one-time debug-level
   * warning so the field-set drift is observable in logs (ADR-11).
   */
  private normalizeSaleResponse(sale: BotSaleResponse): BotSaleResponse {
    if (sale.discountCents === undefined || sale.discountCents === null) {
      if (!discountCentsWarned) {
        discountCentsWarned = true;
        new Logger(ChatbotApiHttpClient.name).debug(
          'chatbot-api `discountCents` omitted on createSale response; defaulting to 0 (legacy backend).',
        );
      }
      return { ...sale, discountCents: 0 };
    }
    return sale;
  }

  async uploadReceipt(
    saleId: string,
    file: ReceiptUploadFile,
    fields: ReceiptUploadFields,
    idempotencyKey: string,
    options: AttachReceiptTransportOptions = {},
  ): Promise<ReceiptUploadResponse> {
    if (
      idempotencyKey.length < 1 ||
      idempotencyKey.length > RECEIPT_UPLOAD_KEY_MAX_LENGTH
    ) {
      throw new ChatbotApiError(
        'Receipt upload idempotency key is out of contract',
        400,
        undefined,
        RECEIPT_UPLOAD_ERROR.INVALID_IDEMPOTENCY_KEY,
      );
    }
    const requestConfig = this.buildAuthedRequestConfig({
      method: 'POST',
      url: `/chatbot-api/sales/${encodeURIComponent(saleId)}/receipts`,
      data: toReceiptUploadForm(file, fields),
      headers: { 'X-Idempotency-Key': idempotencyKey },
      timeout: CHATBOT_API_TIMEOUTS_MS.receiptUpload,
      signal: options.signal,
    });

    let response;
    try {
      // Single attempt: a retry is the caller's, later, with the same key.
      response = await lastValueFrom(
        this.httpService.request<unknown>(requestConfig),
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const body = response.data;
    if (response.status !== 201 || !isReceiptUploadResponse(body)) {
      throw new UpstreamError(
        'Chatbot API receipt upload response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }
    return body;
  }

  /** Receipt outcome read: UUID-validated before any request, safe GET
   * retry policy, HTTP 200 with a strictly parsed body. */
  async getReceiptOutcome(receiptId: string): Promise<ReceiptOutcome> {
    if (!DECISION_ID_UUID.test(receiptId)) {
      throw new ChatbotApiError(
        'Receipt id failed local UUID validation',
        null,
        undefined,
        null,
      );
    }
    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: `/chatbot-api/receipts/${encodeURIComponent(receiptId)}`,
      },
      { retryable: true },
    );
    const body = response.data;
    const outcome = parseReceiptOutcome(body);
    if (response.status !== 200 || outcome === null) {
      throw new UpstreamError(
        'Chatbot API receipt outcome response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }
    return outcome;
  }

  async updateDelivery(
    saleId: string,
    dto: UpdateDeliveryInput,
  ): Promise<void> {
    await this.request<Record<string, never>>({
      method: 'PATCH',
      url: `/chatbot-api/sales/${encodeURIComponent(saleId)}/delivery`,
      data: dto,
    });
  }

  /** The backend defaults a missing country code to `''` (§4.4.9), so a blank
   *  one is refused locally; the body is a tolerant read like the catalog. */
  async getOrderHistory(
    phone: string,
    cc: string,
  ): Promise<OrderHistoryResponse[]> {
    if (typeof cc !== 'string' || cc.trim() === '') {
      throw new ChatbotApiError(
        'Chatbot API order history requires a phoneCountryCode',
        null,
        undefined,
        null,
      );
    }
    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: `/chatbot-api/customers/by-phone/${encodeURIComponent(phone)}/orders`,
        params: {
          phoneCountryCode: cc,
        },
      },
      { retryable: true },
    );
    return this.acceptTolerantRead(
      'order history',
      response,
      [200],
      parseOrderHistoryResponse(response.data),
    );
  }

  getPaymentDetails(): Promise<PaymentDetail> {
    return this.request<PaymentDetail>(
      { method: 'GET', url: '/chatbot-api/payment-details' },
      { retryable: true },
    );
  }

  /**
   * `POST /chatbot-api/sales/:saleId/cancel` (chatbot-api §4.4.10,
   * scope `sales:write`).
   *
   * No client `X-Idempotency-Key` header — the backend derives the
   * idempotency key from `sale:cancel:<saleId>` (SHA-256 of
   * `{saleId, actorId, reason}`); a client-minted header would be
   * ignored / cause a `IDEMPOTENCY_KEY_CONFLICT`. The standard
   * single-branch auth headers (`Authorization` + `X-Branch-Id`)
   * apply as usual (ADR-16).
   */
  cancelSale(saleId: string, dto: CancelSaleInput): Promise<CancelSaleResult> {
    const parsed = CancelSaleInputSchema.parse(dto);
    return this.request<CancelSaleResult>({
      method: 'POST',
      url: `/chatbot-api/sales/${encodeURIComponent(saleId)}/cancel`,
      data: { reason: parsed.reason, cashierUserId: parsed.cashierUserId },
    });
  }

  /**
   * `GET /chatbot-api/human-decisions/:id` current-state poll (contract v1,
   * scope `human-decisions:read`).
   *
   * The bot-only GET is the only source of current `PENDING`/`RESOLVED`
   * state; the immutable POST receipt never is. The decision id is validated
   * as a UUID before any request. It reuses the safe GET retry policy
   * (network/5xx only, bounded to three attempts) and requires an HTTP 200
   * whose body parses as a current decision bound to the requested UUID
   * (case-insensitive). Any unexpected status or malformed/mismatched body
   * throws `UpstreamError` with status, raw body and `errorCode` evidence;
   * transport failures keep flowing through `mapError`. No business-state
   * change or customer notification occurs here.
   */
  async getRestockDecision(decisionId: string): Promise<RestockDecision> {
    if (!DECISION_ID_UUID.test(decisionId)) {
      throw new ChatbotApiError(
        'RESTOCK decision id failed local UUID validation',
        null,
        undefined,
        null,
      );
    }

    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: `/chatbot-api/human-decisions/${encodeURIComponent(decisionId)}`,
      },
      { retryable: true },
    );

    const body = response.data;
    const decision = normalizeRestockDecision(body);

    if (
      response.status !== 200 ||
      decision === null ||
      decision.id.toLowerCase() !== decisionId.toLowerCase()
    ) {
      throw new UpstreamError(
        'Chatbot API current decision poll response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return decision;
  }

  /**
   * EXPIRATION `GET /chatbot-api/human-decisions/:id` current-state poll
   * (contract v1, scope `human-decisions:read`).
   *
   * The decision id must be a canonical lowercase RFC UUID v1–v8 with variant
   * bits 8/9/a/b; a nil, uppercase or whitespace id is rejected before any
   * request. It reuses the safe GET retry policy (network/5xx only, bounded to
   * three attempts; 4xx incl. 429 are never retried) and requires an HTTP 200
   * whose body parses as a current EXPIRATION decision bound EXACTLY to the
   * requested id; otherwise `UpstreamError` retains the status, raw body and
   * `errorCode`. A valid `RESOLVED` decision past its deadline still parses
   * because freshness eligibility belongs to the future runtime. The GET may
   * observe `PENDING`→`RESOLVED` across retries and each attempt consumes rate
   * limit and touches `lastUsedAt`; no polling, store, ACK, send or activation
   * occurs here.
   */
  async getExpirationDecision(decisionId: string): Promise<ExpirationDecision> {
    if (!EXPIRATION_DECISION_ID_UUID.test(decisionId)) {
      throw new ChatbotApiError(
        'EXPIRATION decision id failed local UUID validation',
        null,
        undefined,
        null,
      );
    }

    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: `/chatbot-api/human-decisions/${encodeURIComponent(decisionId)}`,
      },
      { retryable: true },
    );

    const body = response.data;
    const decision = normalizeExpirationDecision(body);

    if (
      response.status !== 200 ||
      decision === null ||
      decision.id !== decisionId
    ) {
      throw new UpstreamError(
        'Chatbot API EXPIRATION decision poll response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return decision;
  }

  /**
   * `POST /chatbot-api/human-decisions/:id/application-outcome` terminal bot
   * ACK (contract v1 addenda, scope `human-decisions:ack`).
   *
   * The decision id is validated as a UUID and the request normalized before
   * any request; a malformed request is rejected without HTTP. The wire body is
   * the exact normalized discriminated DTO. Exactly one POST is attempted — no
   * sleep and no automatic retry even on 5xx or transport ambiguity, because a
   * duplicate terminal outcome would be a second attempt; only a fulfilled
   * HTTP 200 whose five-key body parses as an ACK bound to the requested
   * decision id, `attemptId` and outcome resolves. Any unexpected status or
   * malformed/mismatched body throws `UpstreamError` with status, raw body and
   * `errorCode` evidence; transport failures keep flowing through `mapError`,
   * so `401`/`403`/`409`/`429`/5xx map to their structured errors. No
   * `X-Idempotency-Key` is sent: `attemptId` is the backend replay key. */
  async recordRestockApplicationOutcome(
    decisionId: string,
    request: RestockApplicationOutcomeRequest,
  ): Promise<RestockApplicationOutcomeAck> {
    if (!DECISION_ID_UUID.test(decisionId)) {
      throw new ChatbotApiError(
        'RESTOCK decision id failed local UUID validation',
        null,
        undefined,
        null,
      );
    }

    const sent = normalizeRestockApplicationOutcome(request);
    if (sent === null) {
      throw new ChatbotApiError(
        'RESTOCK application outcome request failed local validation',
        null,
        undefined,
        null,
      );
    }

    const response = await this.requestWithResponse<unknown>({
      method: 'POST',
      url: `/chatbot-api/human-decisions/${encodeURIComponent(decisionId)}/application-outcome`,
      data: sent,
    });

    const body = response.data;
    const ack = normalizeRestockApplicationOutcomeAck(body, decisionId, sent);

    if (response.status !== 200 || ack === null) {
      throw new UpstreamError(
        'Chatbot API application-outcome ACK response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return ack;
  }

  /**
   * DELIVERY_ZONE intake (docs/contracts/delivery-zone-bot-cycle.md §4.1).
   * The exact ten-key body is normalized before any request and
   * `X-Idempotency-Key` equals `sourceRequestId`. Exactly one POST (no retry:
   * a replay is the caller's choice under the same key); only a `201`/`200`
   * requester bound to the sent `sourceRequestId` resolves.
   */
  async submitDeliveryZoneIntake(
    dto: DeliveryZoneIntakeInput,
  ): Promise<DeliveryZoneRequester> {
    const sent = normalizeDeliveryZoneIntake(dto);
    if (sent === null) {
      throw new ChatbotApiError(
        'DELIVERY_ZONE intake DTO failed local validation',
        null,
        undefined,
        null,
      );
    }
    const response = await this.requestWithResponse<unknown>({
      method: 'POST',
      url: '/chatbot-api/human-decisions',
      data: sent,
      headers: { 'X-Idempotency-Key': sent.sourceRequestId },
    });
    const body = response.data;
    const requester = normalizeDeliveryZoneRequester(body);
    if (
      (response.status !== 201 && response.status !== 200) ||
      requester === null ||
      requester.sourceRequestId.toLowerCase() !==
        sent.sourceRequestId.toLowerCase()
    ) {
      throw new UpstreamError(
        'Chatbot API DELIVERY_ZONE intake response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }
    return requester;
  }

  /** DELIVERY_ZONE poll by requester id (§4.2): UUID-validated before any
   * request, safe GET retry policy, HTTP 200 bound to the requested id. */
  async getDeliveryZoneRequester(
    requesterId: string,
  ): Promise<DeliveryZoneRequester> {
    if (!DECISION_ID_UUID.test(requesterId)) {
      throw new ChatbotApiError(
        'DELIVERY_ZONE requester id failed local UUID validation',
        null,
        undefined,
        null,
      );
    }
    const response = await this.requestWithResponse<unknown>(
      {
        method: 'GET',
        url: `/chatbot-api/human-decisions/${encodeURIComponent(requesterId)}`,
      },
      { retryable: true },
    );
    const body = response.data;
    const requester = normalizeDeliveryZoneRequester(body);
    if (
      response.status !== 200 ||
      requester === null ||
      requester.id.toLowerCase() !== requesterId.toLowerCase()
    ) {
      throw new UpstreamError(
        'Chatbot API DELIVERY_ZONE poll response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }
    return requester;
  }

  /**
   * `POST /chatbot-api/human-decisions` RESTOCK intake (contract v1, scope
   * `human-decisions:create`).
   *
   * The local DTO is normalized first and a malformed intake is rejected
   * before any request. The wire body is the exact normalized 10-key intake
   * (optionals present as `null`) and `X-Idempotency-Key` equals the
   * normalized `sourceRequestId`; no source, tenant, branch or PII authority
   * is ever sent in the body. Exactly one POST is attempted — no sleep and no
   * automatic retry even on 5xx or transport ambiguity — and only a `201`
   * (first intake) or `200` (exact replay) response that passes the strict
   * immutable-receipt normalizer resolves. That receipt is historical
   * (`PENDING`/v1) and never represents current decision state.
   */
  async submitRestockIntake(
    dto: RestockIntakeInput,
  ): Promise<RestockIntakeReceipt> {
    const sent = normalizeRestockIntake(dto);
    if (sent === null) {
      throw new ChatbotApiError(
        'RESTOCK intake DTO failed local validation',
        null,
        undefined,
        null,
      );
    }
    return this.requestRestockIntake(sent);
  }

  private async requestRestockIntake(
    sent: RestockIntakeInput,
  ): Promise<RestockIntakeReceipt> {
    const requestConfig = this.buildAuthedRequestConfig({
      method: 'POST',
      url: '/chatbot-api/human-decisions',
      data: sent,
      headers: { 'X-Idempotency-Key': sent.sourceRequestId },
    });

    let response;
    try {
      response = await lastValueFrom(
        this.httpService.request<unknown>(requestConfig),
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const body = response.data;

    if (response.status !== 201 && response.status !== 200) {
      throw new UpstreamError(
        'Chatbot API RESTOCK intake returned an unexpected status',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    const receipt = normalizeRestockIntakeReceipt(body, sent);
    if (receipt === null) {
      throw new UpstreamError(
        'Chatbot API RESTOCK intake response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return receipt;
  }

  /**
   * `POST /chatbot-api/human-decisions` EXPIRATION intake (contract v1, scope
   * `human-decisions:create`).
   *
   * The four-key DTO is normalized first and malformed input is rejected before
   * any request. The wire body is that exact normalized intake and
   * `X-Idempotency-Key` is the literal sent `sourceRequestId` (case preserved);
   * no source, tenant, branch or PII authority is sent. Exactly one POST is
   * attempted — no sleep, no automatic retry even on 5xx or transport
   * ambiguity — and only a `201`/`200` immutable historical receipt bound to
   * the sent identity resolves. That receipt is `PENDING`/v1, never current
   * state, and nothing here is wired to runtime.
   */
  async submitExpirationIntake(
    dto: ExpirationIntakeInput,
  ): Promise<ExpirationIntakeReceipt> {
    const sent = normalizeExpirationIntake(dto);
    if (sent === null) {
      throw new ChatbotApiError(
        'EXPIRATION intake DTO failed local validation',
        null,
        undefined,
        null,
      );
    }
    return this.requestExpirationIntake(sent);
  }

  private async requestExpirationIntake(
    sent: ExpirationIntakeInput,
  ): Promise<ExpirationIntakeReceipt> {
    const requestConfig = this.buildAuthedRequestConfig({
      method: 'POST',
      url: '/chatbot-api/human-decisions',
      data: sent,
      headers: { 'X-Idempotency-Key': sent.sourceRequestId },
    });

    let response;
    try {
      response = await lastValueFrom(
        this.httpService.request<unknown>(requestConfig),
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const body = response.data;

    if (response.status !== 201 && response.status !== 200) {
      throw new UpstreamError(
        'Chatbot API EXPIRATION intake returned an unexpected status',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    const receipt = normalizeExpirationIntakeReceipt(body, sent);
    if (receipt === null) {
      throw new UpstreamError(
        'Chatbot API EXPIRATION intake response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return receipt;
  }

  /**
   * `POST /chatbot-api/requests` (5a). The input is checked locally (the
   * backend owns full validation) and only known keys go on the wire, with
   * `X-Idempotency-Key` = `sourceRequestId`. Exactly one POST; documented
   * errors resolve as typed results, transport failures reject.
   */
  async createHumanRequest(
    input: CreateHumanRequestInput,
  ): Promise<CreateHumanRequestResult> {
    if (!isCreateHumanRequestInput(input)) {
      throw new ChatbotApiError(
        'Human request input failed local validation',
        null,
        undefined,
        null,
      );
    }
    let response: AxiosResponse<unknown>;
    try {
      response = await this.requestWithResponse<unknown>({
        method: 'POST',
        url: '/chatbot-api/requests',
        data: toCreateHumanRequestBody(input),
        headers: { 'X-Idempotency-Key': input.sourceRequestId },
      });
    } catch (error) {
      const failure = documentedFailure(error);
      if (failure === null) throw error;
      const { status, code, body, retryAfterSeconds } = failure;
      if (status === 409 && code === 'CUSTOMER_OPEN_LIMIT')
        return {
          kind: code,
          limit: numberField(body, 'limit'),
          open: numberField(body, 'open'),
        };
      if (status === 429 && code === 'CUSTOMER_RATE_LIMITED')
        return {
          kind: code,
          limit: numberField(body, 'limit'),
          retryAfterSeconds,
        };
      if (status === 429) return { kind: 'RATE_LIMITED', retryAfterSeconds };
      if (
        (status === 409 &&
          (code === 'IDEMPOTENCY_CONFLICT' || code === 'VERSION_CONFLICT')) ||
        (status === 422 &&
          (code === 'SUBTYPE_DISABLED' || code === 'SCHEDULING_DISABLED'))
      )
        return { kind: code };
      if (status === 409 && code === 'SLOT_UNAVAILABLE') {
        // A body that breaks the contract falls through to the throw below.
        const unavailable = parseSlotUnavailable(body);
        if (unavailable !== null) return unavailable;
      }
      if (status === 409 && code === 'ALREADY_SCHEDULED') {
        const already = parseAlreadyScheduled(body);
        if (already !== null) return already;
      }
      if (status === 400)
        return { kind: 'VALIDATION_ERROR', message: messageField(body) };
      if (status === 404) return { kind: 'NOT_FOUND' };
      throw error;
    }
    const created = parseHumanRequestCreated(response.data);
    if ((response.status !== 201 && response.status !== 200) || !created) {
      throw new UpstreamError(
        'Chatbot API create request response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return { kind: 'ok', status: response.status, response: created };
  }

  /** `POST /chatbot-api/requests/:id/cancel` (5a): exactly one POST with the
   *  caller's key; the 200 must bind to the requested id. */
  async cancelHumanRequest(
    requestId: string,
    input: CancelHumanRequestInput,
    idempotencyKey: string,
  ): Promise<CancelHumanRequestResult> {
    if (requestId.trim() === '' || idempotencyKey.trim() === '') {
      throw new ChatbotApiError(
        'Human request cancel needs a request id and an idempotency key',
        null,
        undefined,
        null,
      );
    }
    let response: AxiosResponse<unknown>;
    try {
      response = await this.requestWithResponse<unknown>({
        method: 'POST',
        url: `/chatbot-api/requests/${encodeURIComponent(requestId)}/cancel`,
        data: {
          reason: input.reason,
          triggerWaMessageId: input.triggerWaMessageId,
        },
        headers: { 'X-Idempotency-Key': idempotencyKey },
      });
    } catch (error) {
      const failure = documentedFailure(error);
      if (failure === null) throw error;
      const { status, code, body, retryAfterSeconds } = failure;
      if (status === 409 && code === 'ALREADY_RESOLVED')
        return {
          kind: code,
          resolution: (body as { resolution?: unknown })?.resolution ?? null,
        };
      if (
        status === 409 &&
        (code === 'REQUEST_CLOSED' ||
          code === 'CANCEL_NOT_ALLOWED' ||
          code === 'IDEMPOTENCY_CONFLICT')
      )
        return { kind: code };
      if (status === 404) return { kind: 'NOT_FOUND' };
      if (status === 429) return { kind: 'RATE_LIMITED', retryAfterSeconds };
      throw error;
    }
    const cancelled = parseHumanRequestCancelled(response.data);
    if (
      response.status !== 200 ||
      !cancelled ||
      cancelled.id.toLowerCase() !== requestId.toLowerCase()
    ) {
      throw new UpstreamError(
        'Chatbot API cancel request response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return { kind: 'ok', response: cancelled };
  }

  /**
   * `GET /chatbot-api/feed` long-poll (5b). Options are validated locally
   * (never clamped). Single attempt — the consumer loop owns reconnects and
   * backoff — with a timeout of `waitSeconds * 1000 + FEED_TIMEOUT_SLACK_MS`.
   * A page with any malformed item rejects with `UpstreamError`.
   */
  async readFeed(options: ReadFeedOptions = {}): Promise<ReadFeedResult> {
    const {
      after,
      limit = FEED_MAX_LIMIT,
      waitSeconds = FEED_MAX_WAIT_SECONDS,
    } = options;
    if (
      (after !== undefined && (typeof after !== 'string' || after === '')) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > FEED_MAX_LIMIT ||
      !Number.isInteger(waitSeconds) ||
      waitSeconds < 0 ||
      waitSeconds > FEED_MAX_WAIT_SECONDS
    ) {
      throw new ChatbotApiError(
        'Feed read options are out of contract',
        null,
        undefined,
        null,
      );
    }
    let response: AxiosResponse<unknown>;
    try {
      response = await this.requestWithResponse<unknown>({
        method: 'GET',
        url: '/chatbot-api/feed',
        params: {
          ...(after === undefined ? {} : { after }),
          limit,
          waitSeconds,
        },
        timeout: waitSeconds * 1000 + FEED_TIMEOUT_SLACK_MS,
      });
    } catch (error) {
      const failure = documentedFailure(error);
      if (failure?.status === 410 && failure.code === 'CURSOR_EXPIRED')
        return { kind: 'CURSOR_EXPIRED' };
      if (failure?.status === 429)
        return {
          kind: 'RATE_LIMITED',
          retryAfterSeconds: failure.retryAfterSeconds,
        };
      throw error;
    }
    const page = parseFeedPage(response.data);
    if (response.status !== 200 || page === null) {
      throw new UpstreamError(
        'Chatbot API feed response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return { kind: 'ok', ...page };
  }

  /** `POST /chatbot-api/deliveries/:deliveryId/outcome` (5b). The exact
   *  variant body is validated before any HTTP; exactly one POST; the 200 must
   *  bind to the delivery, `attemptId` and outcome sent. */
  async recordDeliveryOutcome(
    deliveryId: string,
    input: DeliveryOutcomeInput,
  ): Promise<RecordDeliveryOutcomeResult> {
    const sent = normalizeDeliveryOutcome(input);
    if (deliveryId.trim() === '' || sent === null) {
      throw new ChatbotApiError(
        'Delivery outcome failed local validation',
        null,
        undefined,
        null,
      );
    }
    let response: AxiosResponse<unknown>;
    try {
      response = await this.requestWithResponse<unknown>({
        method: 'POST',
        url: `/chatbot-api/deliveries/${encodeURIComponent(deliveryId)}/outcome`,
        data: sent,
      });
    } catch (error) {
      const failure = documentedFailure(error);
      if (failure === null) throw error;
      const { status, code, body, retryAfterSeconds } = failure;
      if (
        status === 409 &&
        (code === 'IDEMPOTENCY_CONFLICT' || code === 'OUTCOME_ALREADY_RECORDED')
      )
        return { kind: code };
      if (status === 422 && code === 'OUTCOME_NOT_ALLOWED')
        return { kind: code };
      if (status === 404) return { kind: 'NOT_FOUND' };
      if (status === 429) return { kind: 'RATE_LIMITED', retryAfterSeconds };
      if (status === 400)
        return { kind: 'VALIDATION_ERROR', message: messageField(body) };
      throw error;
    }
    const ack = parseDeliveryOutcomeAck(response.data);
    if (
      response.status !== 200 ||
      ack === null ||
      ack.deliveryId.toLowerCase() !== deliveryId.toLowerCase() ||
      ack.attemptId !== sent.attemptId ||
      ack.outcome !== sent.outcome
    ) {
      throw new UpstreamError(
        'Chatbot API delivery outcome response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return { kind: 'ok', response: ack };
  }

  /** `GET /chatbot-api/requests/pending-deliveries` (5b) with exactly one
   *  non-empty filter; safe GET retry policy; feed item validation. */
  async listPendingDeliveries(
    filter: PendingDeliveriesFilter,
  ): Promise<PendingDeliveriesResult> {
    const { conversationRef, requestId } = filter as {
      conversationRef?: unknown;
      requestId?: unknown;
    };
    const given = [conversationRef, requestId].filter((v) => v !== undefined);
    if (
      given.length !== 1 ||
      typeof given[0] !== 'string' ||
      given[0].trim() === ''
    ) {
      throw new ChatbotApiError(
        'Pending deliveries needs exactly one of conversationRef or requestId',
        null,
        undefined,
        null,
      );
    }
    let response: AxiosResponse<unknown>;
    try {
      response = await this.requestWithResponse<unknown>(
        {
          method: 'GET',
          url: '/chatbot-api/requests/pending-deliveries',
          params:
            conversationRef === undefined ? { requestId } : { conversationRef },
        },
        { retryable: true },
      );
    } catch (error) {
      const failure = documentedFailure(error);
      if (failure?.status === 429)
        return {
          kind: 'RATE_LIMITED',
          retryAfterSeconds: failure.retryAfterSeconds,
        };
      throw error;
    }
    const items = parsePendingDeliveries(response.data);
    if (response.status !== 200 || items === null) {
      throw new UpstreamError(
        'Chatbot API pending deliveries response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return { kind: 'ok', items };
  }

  /** `GET /chatbot-api/requests?status=open` (5c recovery): one page with
   *  `updatedSince` (canonical UTC ms), `cursor` (`nextPage`) and `limit`
   *  validated before any HTTP; safe GET retry policy. A page with any
   *  malformed request rejects with `UpstreamError`. */
  async listOpenRequests(
    options: ListOpenRequestsOptions = {},
  ): Promise<ListOpenRequestsResult> {
    const { updatedSince, cursor, limit = OPEN_REQUESTS_MAX_LIMIT } = options;
    if (
      (updatedSince !== undefined && !isCanonicalUtcMs(updatedSince)) ||
      (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > OPEN_REQUESTS_MAX_LIMIT
    ) {
      throw new ChatbotApiError(
        'Open requests options are out of contract',
        null,
        undefined,
        null,
      );
    }
    let response: AxiosResponse<unknown>;
    try {
      response = await this.requestWithResponse<unknown>(
        {
          method: 'GET',
          url: '/chatbot-api/requests',
          params: {
            status: 'open',
            ...(updatedSince === undefined ? {} : { updatedSince }),
            ...(cursor === undefined ? {} : { cursor }),
            limit,
          },
        },
        { retryable: true },
      );
    } catch (error) {
      const failure = documentedFailure(error);
      if (failure?.status === 429)
        return {
          kind: 'RATE_LIMITED',
          retryAfterSeconds: failure.retryAfterSeconds,
        };
      if (failure?.status === 400)
        return {
          kind: 'VALIDATION_ERROR',
          message: messageField(failure.body),
        };
      throw error;
    }
    const page = parseOpenRequestsPage(response.data);
    if (response.status !== 200 || page === null) {
      throw new UpstreamError(
        'Chatbot API open requests response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    }
    return { kind: 'ok', ...page };
  }

  /**
   * `POST /chatbot-api/conversations/:conversationRef/messages:batch`
   * (unit 9). Validated locally, exactly one POST (the outbox owns retries),
   * every documented answer a typed result. The ref is URL-encoded and never
   * appears in a result or a log.
   */
  async mirrorMessages(
    conversationRef: string,
    messages: readonly MirrorMessageInput[],
  ): Promise<MirrorMessagesResult> {
    if (!isValidConversationRef(conversationRef))
      return localValidation(
        `conversationRef is out of contract (1 to ${MIRROR_CONVERSATION_REF_MAX_CHARS} characters of A-Z a-z 0-9 : _ . @ + -)`,
      );
    const invalid = validateMirrorMessages(messages, Date.now());
    if (invalid !== null) return invalid;
    const outcome = await this.mirrorPost({
      method: 'POST',
      url: `/chatbot-api/conversations/${encodeURIComponent(conversationRef)}/messages:batch`,
      data: toMirrorMessagesBody(messages),
      timeout: CONVERSATION_MIRROR_TIMEOUTS_MS.batch,
    });
    if (!outcome.ok) {
      const { status, code, body } = outcome.failure;
      if (status === 409 && code === 'MESSAGE_ID_CONFLICT')
        return { kind: 'MESSAGE_ID_CONFLICT' };
      if (status === 413 && code === 'BATCH_TOO_LARGE')
        return {
          kind: 'BATCH_TOO_LARGE',
          limit: numberField(body, 'limit') ?? 50,
          local: false,
        };
      if (status === 422 && code === 'MEDIA_NOT_FOUND')
        return { kind: 'MEDIA_NOT_FOUND' };
      if (status === 422 && code === 'MEDIA_TYPE_MISMATCH')
        return { kind: 'MEDIA_TYPE_MISMATCH' };
      if (status === 422 && code === 'REPLY_NOT_FOUND')
        return { kind: 'REPLY_NOT_FOUND' };
      return classifyMirrorFailure(outcome.failure);
    }
    const ack = parseMirrorBatchAck(outcome.response.data);
    if (outcome.response.status !== 200 || ack === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return { kind: 'ok', ...ack };
  }

  /** `POST /chatbot-api/messages/statuses:batch` (unit 9), 1–100 statuses. */
  async recordMessageStatuses(
    statuses: readonly MirrorStatusInput[],
  ): Promise<MirrorStatusesResult> {
    const invalid = validateMirrorStatuses(statuses, Date.now());
    if (invalid !== null) return invalid;
    const outcome = await this.mirrorPost({
      method: 'POST',
      url: '/chatbot-api/messages/statuses:batch',
      data: toMirrorStatusesBody(statuses),
      timeout: CONVERSATION_MIRROR_TIMEOUTS_MS.batch,
    });
    if (!outcome.ok) {
      const { status, code, body } = outcome.failure;
      if (status === 413 && code === 'BATCH_TOO_LARGE')
        return {
          kind: 'BATCH_TOO_LARGE',
          limit: numberField(body, 'limit') ?? 100,
          local: false,
        };
      return classifyMirrorFailure(outcome.failure);
    }
    const ack = parseMirrorStatusAck(outcome.response.data);
    if (outcome.response.status !== 200 || ack === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return { kind: 'ok', ...ack };
  }

  /**
   * `POST /chatbot-api/media` (unit 9): one streamed multipart `file` part
   * (S1: the file is never buffered whole; a 10 MiB cap is enforced before and
   * while streaming) with the caller's lowercase-UUID `X-Idempotency-Key`.
   * Exactly one POST; the caller retries 5xx/503 with the same key.
   */
  async uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    const shaSent = input.sha256 !== undefined;
    const rejectLocally = (
      message: string,
    ): Extract<UploadMediaResult, { kind: 'VALIDATION_ERROR' }> => {
      // The caller's stream is ours to release once the upload is refused.
      input.stream?.destroy();
      return { ...localValidation(message), shaSent };
    };
    if (!isLowercaseUuid(input.idempotencyKey))
      return rejectLocally('idempotencyKey must be a lowercase UUID');
    if ((input.filePath === undefined) === (input.stream === undefined))
      return rejectLocally('Exactly one of filePath or stream is required');
    if (shaSent && !isSha256Hex(input.sha256))
      return rejectLocally('sha256 must be 64 lowercase hex characters');
    if (
      input.sizeBytes !== undefined &&
      (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    )
      return rejectLocally('sizeBytes must be a non-negative integer');

    let sizeBytes = input.sizeBytes;
    if (input.filePath !== undefined) {
      try {
        const stats = await fsPromises.stat(input.filePath);
        if (!stats.isFile()) return rejectLocally('Media path is not a file');
        sizeBytes = stats.size;
      } catch {
        // The path is deliberately not echoed.
        return rejectLocally('Media file is not readable');
      }
    }
    if (sizeBytes !== undefined && sizeBytes > MEDIA_MAX_BYTES) {
      input.stream?.destroy();
      return { kind: 'MEDIA_TOO_LARGE', local: true };
    }
    if (sizeBytes === 0) return rejectLocally('Media file is empty');

    const source: Readable =
      input.stream ?? createReadStream(input.filePath as string);
    // A caller that already aborted never reaches the network.
    if (input.signal?.aborted) {
      source.destroy();
      return { kind: 'ABORTED' };
    }
    let capExceeded = false;
    let sourceFailed = false;
    const multipart = createMediaMultipart({
      source,
      filename: safeMediaFilename(input.filename),
      sha256: input.sha256,
      sizeBytes,
      onCapExceeded: () => {
        capExceeded = true;
      },
      onSizeMismatch: () => {
        sourceFailed = true;
      },
      onSourceError: () => {
        sourceFailed = true;
      },
    });
    const headers: Record<string, string | number> = {
      'Content-Type': multipart.contentType,
      'X-Idempotency-Key': input.idempotencyKey,
    };
    if (multipart.contentLength !== null)
      headers['Content-Length'] = multipart.contentLength;

    const outcome = await this.mirrorPost({
      method: 'POST',
      url: '/chatbot-api/media',
      data: multipart.body,
      headers,
      timeout: CONVERSATION_MIRROR_TIMEOUTS_MS.mediaUpload,
      // Native transport: follow-redirects would buffer the streamed body.
      maxRedirects: 0,
      signal: input.signal,
    });
    if (!outcome.ok) {
      // The request failed before (or without) consuming the body: release it.
      multipart.body.destroy();
      source.destroy();
      if (capExceeded) return { kind: 'MEDIA_TOO_LARGE', local: true };
      // Local deterministic failures are not transport failures: a retry would
      // fail the same way and burn the shared `write` budget (L7a).
      if (sourceFailed) return { kind: 'LOCAL_SOURCE_ERROR' };
      if (input.signal?.aborted) return { kind: 'ABORTED' };
      const failure = outcome.failure;
      const { status, code } = failure;
      if (status === 400)
        return {
          kind: 'VALIDATION_ERROR',
          message: messageField(failure.body),
          local: false,
          shaSent,
        };
      if (status === 409 && code === 'IDEMPOTENCY_CONFLICT')
        return { kind: 'IDEMPOTENCY_CONFLICT' };
      if (status === 413 && (code === null || code === 'MEDIA_TOO_LARGE'))
        return { kind: 'MEDIA_TOO_LARGE', local: false };
      if (
        status === 415 &&
        (code === null || code === 'MEDIA_TYPE_NOT_ALLOWED')
      )
        return { kind: 'MEDIA_TYPE_NOT_ALLOWED' };
      if (status === 503 && code === 'MEDIA_STORAGE_FAILED')
        return {
          kind: 'MEDIA_STORAGE_FAILED',
          retryAfterSeconds: failure.retryAfterSeconds,
        };
      return classifyMirrorFailure(failure) as Exclude<
        UploadMediaResult,
        { kind: 'VALIDATION_ERROR' }
      >;
    }
    const { status } = outcome.response;
    const uploaded =
      status === 201 || status === 200
        ? parseUploadedMedia(outcome.response.data, status === 201)
        : null;
    if (uploaded === null) return { kind: 'UNEXPECTED', status, code: null };
    return { kind: 'ok', ...uploaded };
  }

  // ------------------------------------------------ live conversation (u11)

  /**
   * `POST /chatbot-api/conversations/:conversationRef/session-ack` (unit 11).
   * Exactly one POST with a short timeout: 409 `STALE_EPOCH` /
   * `SESSION_NOT_ENDING` are reconcile signals, never retried here. Never
   * throws; the ref never appears in a result or a log.
   */
  async sessionAck(
    conversationRef: string,
    input: SessionAckInput,
  ): Promise<SessionAckResult> {
    if (!isValidConversationRef(conversationRef))
      return localValidation(
        `conversationRef is out of contract (1 to ${MIRROR_CONVERSATION_REF_MAX_CHARS} characters of A-Z a-z 0-9 : _ . @ + -)`,
      );
    const problem = sessionAckProblem(input);
    if (problem !== null) return localValidation(problem);
    const outcome = await this.mirrorPost({
      method: 'POST',
      url: `/chatbot-api/conversations/${encodeURIComponent(conversationRef)}/session-ack`,
      data: toSessionAckBody(input),
      timeout: LIVE_CONVERSATION_TIMEOUTS_MS.sessionAck,
    });
    if (!outcome.ok) {
      const { status, code, body } = outcome.failure;
      if (status === 409 && code === 'STALE_EPOCH')
        return parseStaleEpoch(body) ?? { kind: 'UNEXPECTED', status, code };
      if (status === 409 && code === 'SESSION_NOT_ENDING')
        return { kind: 'SESSION_NOT_ENDING' };
      if (status === 404) return { kind: 'NOT_FOUND' };
      return classifyMirrorFailure(outcome.failure);
    }
    const ok =
      outcome.response.status === 200
        ? parseSessionAckOk(outcome.response.data)
        : null;
    if (ok === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return ok;
  }

  /**
   * `GET /chatbot-api/conversations/:conversationRef/state` (unit 11). A 404
   * (a conversation the backend never saw) reads as BOT, epoch 0.
   */
  async getConversationState(
    conversationRef: string,
  ): Promise<GetConversationStateResult> {
    if (!isValidConversationRef(conversationRef))
      return localValidation(
        `conversationRef is out of contract (1 to ${MIRROR_CONVERSATION_REF_MAX_CHARS} characters of A-Z a-z 0-9 : _ . @ + -)`,
      );
    const outcome = await this.mirrorPost({
      method: 'GET',
      url: `/chatbot-api/conversations/${encodeURIComponent(conversationRef)}/state`,
      timeout: LIVE_CONVERSATION_TIMEOUTS_MS.read,
    });
    if (!outcome.ok) {
      if (outcome.failure.status === 404)
        return { kind: 'ok', ...UNKNOWN_CONVERSATION_STATE };
      return classifyMirrorFailure(outcome.failure);
    }
    const state =
      outcome.response.status === 200
        ? parseConversationState(outcome.response.data)
        : null;
    if (state === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return { kind: 'ok', ...state };
  }

  /** `GET /chatbot-api/conversations/state?mode=HUMAN` (unit 11): one page. */
  async listHumanConversations(
    options: ListHumanConversationsOptions = {},
  ): Promise<ListHumanConversationsResult> {
    const problem = listHumanConversationsProblem(options);
    if (problem !== null) return localValidation(problem);
    const params: Record<string, string | number> = { mode: 'HUMAN' };
    if (options.limit !== undefined) params.limit = options.limit;
    if (options.cursor !== undefined) params.cursor = options.cursor;
    const outcome = await this.mirrorPost({
      method: 'GET',
      url: '/chatbot-api/conversations/state',
      params,
      timeout: LIVE_CONVERSATION_TIMEOUTS_MS.read,
    });
    if (!outcome.ok) return classifyMirrorFailure(outcome.failure);
    const page =
      outcome.response.status === 200
        ? parseHumanConversationList(outcome.response.data)
        : null;
    if (page === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return { kind: 'ok', ...page };
  }

  // ------------------------------------------------ scheduling (unit 14)

  /**
   * `GET /chatbot-api/scheduling/slots` (unit 14). One GET, never retried
   * here; `422 SCHEDULING_DISABLED` is its own kind (fall back to the unit 11
   * out-of-hours create). Never throws; the ref never appears in a result or
   * a log.
   */
  async listSlots(input: ListSlotsInput): Promise<ListSlotsResult> {
    if (!isValidConversationRef(input?.conversationRef))
      return localValidation(
        `conversationRef is out of contract (1 to ${MIRROR_CONVERSATION_REF_MAX_CHARS} characters of A-Z a-z 0-9 : _ . @ + -)`,
      );
    const problem = listSlotsProblem(input);
    if (problem !== null) return localValidation(problem);
    const outcome = await this.mirrorPost({
      method: 'GET',
      url: '/chatbot-api/scheduling/slots',
      params: {
        conversationRef: input.conversationRef,
        lastCustomerMessageAt: input.lastCustomerMessageAt,
      },
      timeout: SCHEDULING_TIMEOUTS_MS.slots,
    });
    if (!outcome.ok) {
      const { status, code } = outcome.failure;
      if (status === 422 && code === 'SCHEDULING_DISABLED')
        return { kind: 'SCHEDULING_DISABLED' };
      return classifyMirrorFailure(outcome.failure);
    }
    const answer =
      outcome.response.status === 200
        ? parseSlotsAnswer(outcome.response.data)
        : null;
    if (answer === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return { kind: 'ok', ...answer };
  }

  /**
   * `POST /chatbot-api/requests/:id/reschedule` (unit 14) with the caller's
   * `X-Idempotency-Key`. Exactly one POST, never retried here (a
   * SLOT_UNAVAILABLE means re-offer; the key may be reused after any 4xx).
   * Never throws.
   */
  async rescheduleRequest(
    requestId: string,
    input: RescheduleRequestInput,
    idempotencyKey: string,
  ): Promise<RescheduleRequestResult> {
    const problem = rescheduleProblem(requestId, input, idempotencyKey);
    if (problem !== null || !isSchedulingIdempotencyKey(idempotencyKey))
      return localValidation(problem ?? 'idempotencyKey must be a UUID');
    const outcome = await this.mirrorPost({
      method: 'POST',
      url: `/chatbot-api/requests/${encodeURIComponent(requestId)}/reschedule`,
      data: toRescheduleBody(input),
      headers: { 'X-Idempotency-Key': idempotencyKey },
      timeout: SCHEDULING_TIMEOUTS_MS.reschedule,
    });
    if (!outcome.ok) {
      const { status, code, body } = outcome.failure;
      if (status === 409 && code === 'SLOT_UNAVAILABLE')
        return (
          parseSlotUnavailable(body) ?? { kind: 'UNEXPECTED', status, code }
        );
      if (
        status === 409 &&
        (code === 'REQUEST_CLOSED' ||
          code === 'NOT_SCHEDULED' ||
          code === 'RESCHEDULE_NOT_ALLOWED' ||
          code === 'IDEMPOTENCY_CONFLICT')
      )
        return { kind: code };
      if (status === 422 && code === 'SCHEDULING_DISABLED')
        return { kind: 'SCHEDULING_DISABLED' };
      if (status === 404) return { kind: 'NOT_FOUND' };
      return classifyMirrorFailure(outcome.failure);
    }
    const ok =
      outcome.response.status === 200
        ? parseRescheduleOk(outcome.response.data, requestId)
        : null;
    if (ok === null)
      return {
        kind: 'UNEXPECTED',
        status: outcome.response.status,
        code: null,
      };
    return ok;
  }

  /**
   * `GET /chatbot-api/media/:id` (unit 11, scope `media:read`). The body is
   * streamed through a byte counter + SHA-256 into a mode-0600 temp file
   * (never buffered whole); the cap is checked against the declared
   * `Content-Length` and again while streaming. One GET, no retries; any
   * failure leaves nothing on disk.
   */
  async downloadStaffMedia(
    mediaId: string,
    options: DownloadStaffMediaOptions = {},
  ): Promise<DownloadStaffMediaResult> {
    const maxBytes = options.maxBytes ?? STAFF_MEDIA_MAX_BYTES;
    if (!isStaffMediaId(mediaId))
      return localValidation('mediaId must be a UUID');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > STAFF_MEDIA_MAX_BYTES
    )
      return localValidation(
        `maxBytes must be an integer from 1 to ${STAFF_MEDIA_MAX_BYTES}`,
      );

    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      LIVE_CONVERSATION_TIMEOUTS_MS.mediaDownload,
    );
    const transportFailure = (): Extract<
      DownloadStaffMediaResult,
      { kind: 'RETRYABLE' }
    > => ({
      kind: 'RETRYABLE',
      cause: deadline.signal.aborted ? 'timeout' : 'network',
      status: null,
      retryAfterSeconds: null,
    });
    try {
      const outcome = await this.mirrorPost({
        method: 'GET',
        url: `/chatbot-api/media/${mediaId}`,
        responseType: 'stream',
        timeout: LIVE_CONVERSATION_TIMEOUTS_MS.mediaDownload,
        // Native transport: follow-redirects would buffer the streamed body.
        maxRedirects: 0,
        signal: deadline.signal,
      });
      if (!outcome.ok) {
        const failure = await readStreamedErrorBody(outcome.failure);
        if (failure.status === 404 && failure.code === 'MEDIA_NOT_FOUND')
          return { kind: 'MEDIA_NOT_FOUND' };
        if (failure.status === null && deadline.signal.aborted)
          return transportFailure();
        return classifyMirrorFailure(failure);
      }

      const { response } = outcome;
      const source = response.data;
      const unexpected = (): DownloadStaffMediaResult => {
        if (source instanceof Readable) source.destroy();
        return { kind: 'UNEXPECTED', status: response.status, code: null };
      };
      if (response.status !== 200 || !(source instanceof Readable))
        return unexpected();
      const mimeType = headerValue(response.headers, 'content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase();
      if (!isStaffMediaMimeType(mimeType)) return unexpected();
      const declaredRaw = headerValue(response.headers, 'content-length');
      const declared =
        declaredRaw !== undefined && /^\d+$/.test(declaredRaw)
          ? Number(declaredRaw)
          : null;
      if (declared !== null && declared > maxBytes) {
        source.destroy();
        return { kind: 'MEDIA_TOO_LARGE' };
      }
      // A transformed (compressed) body legitimately differs from the header.
      const encoding = headerValue(response.headers, 'content-encoding');
      const lengthIsExact =
        declared !== null &&
        (encoding === undefined || encoding.toLowerCase() === 'identity');
      const filename = safeMediaFilename(
        contentDispositionFilename(
          headerValue(response.headers, 'content-disposition'),
        ),
      );

      let handle: fsPromises.FileHandle;
      let filePath: string;
      try {
        filePath = join(
          tmpdir(),
          `staff-media-${randomBytes(12).toString('hex')}`,
        );
        handle = await fsPromises.open(filePath, 'wx', 0o600);
      } catch {
        // The path is deliberately not echoed.
        source.destroy();
        return { kind: 'LOCAL_IO_ERROR' };
      }
      const removeFile = async (): Promise<void> => {
        try {
          await fsPromises.unlink(filePath);
        } catch {
          // Already gone (or never fully created): nothing left to remove.
        }
      };

      const hash = createHash('sha256');
      let total = 0;
      let capped = false;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          total += chunk.length;
          if (total > maxBytes) {
            capped = true;
            callback(new Error('Staff media exceeds the byte cap'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const sink = handle.createWriteStream();
      let firstFailure: 'source' | 'sink' | null = null;
      source.once('error', () => {
        firstFailure ??= 'source';
      });
      sink.once('error', () => {
        firstFailure ??= 'sink';
      });
      try {
        await pipeline(source, meter, sink);
      } catch {
        // pipeline destroyed every stream; the sink closed the handle.
        await removeFile();
        if (capped) return { kind: 'MEDIA_TOO_LARGE' };
        if (firstFailure === 'sink') return { kind: 'LOCAL_IO_ERROR' };
        return transportFailure();
      }
      if (total === 0) {
        await removeFile();
        return { kind: 'UNEXPECTED', status: response.status, code: null };
      }
      if (lengthIsExact && total !== declared) {
        // Truncated (or padded) transfer: retry the whole download.
        await removeFile();
        return {
          kind: 'RETRYABLE',
          cause: 'network',
          status: null,
          retryAfterSeconds: null,
        };
      }
      return {
        kind: 'ok',
        filePath,
        mimeType,
        filename,
        sizeBytes: total,
        sha256: hash.digest('hex'),
        cleanup: removeFile,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One POST for the unit 9 routes, never retried here. Failures are reduced
   * to status / backend code / Retry-After / transport cause: the axios error
   * (whose message could carry a URL with the conversation ref) is dropped.
   */
  private async mirrorPost(
    config: AxiosRequestConfig,
  ): Promise<
    | { ok: true; response: AxiosResponse<unknown> }
    | { ok: false; failure: MirrorRawFailure }
  > {
    const requestConfig = this.buildAuthedRequestConfig(config);
    try {
      const response = await lastValueFrom(
        this.httpService.request<unknown>(requestConfig),
      );
      return { ok: true, response };
    } catch (error) {
      const raw = error as {
        code?: unknown;
        response?: {
          status?: unknown;
          data?: unknown;
          headers?: Record<string, string | string[] | undefined>;
        };
      };
      const status =
        typeof raw.response?.status === 'number' ? raw.response.status : null;
      const body = raw.response?.data;
      const scoped =
        typeof body === 'object' && body !== null
          ? (body as { code?: unknown }).code
          : undefined;
      return {
        ok: false,
        failure: {
          status,
          code: typeof scoped === 'string' && scoped !== '' ? scoped : null,
          body,
          retryAfterSeconds: this.parseRetryAfter(raw.response?.headers),
          transportCode: typeof raw.code === 'string' ? raw.code : null,
        },
      };
    }
  }

  /**
   * Shared single-branch auth envelope: base URL + `Authorization` and
   * `X-Branch-Id` headers (ADR-16), applied identically to every
   * chatbot-api request including the attachment-only transport. A request
   * without its own `timeout` gets the bounded default.
   */
  private buildAuthedRequestConfig(
    config: AxiosRequestConfig,
  ): AxiosRequestConfig {
    return {
      ...config,
      timeout: config.timeout ?? CHATBOT_API_TIMEOUTS_MS.default,
      baseURL:
        this.configService.getOrThrow<AppConfig['chatbotApi']['baseUrl']>(
          'chatbotApi.baseUrl',
        ),
      headers: {
        ...(config.headers ?? {}),
        Authorization: `Bearer ${this.configService.getOrThrow<AppConfig['chatbotApi']['serviceKey']>('chatbotApi.serviceKey')}`,
        'X-Branch-Id': this.configService.getOrThrow<
          AppConfig['chatbotApi']['branchId']
        >('chatbotApi.branchId'),
      },
    };
  }

  /** Body-only facade preserving the existing methods' return semantics. */
  private async request<T>(
    config: AxiosRequestConfig,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.requestWithResponse<T>(config, options);
    return response.data;
  }

  /**
   * Full-response seam shared with `request`: identical single-branch guard
   * and safe retry policy (network/5xx only, bounded to three attempts),
   * exposing the HTTP status and raw body so the current-decision poll can
   * require `200` and keep evidence on unexpected or malformed bodies. Only
   * the returned shape changes; existing methods still receive the body.
   */
  private async requestWithResponse<T>(
    config: AxiosRequestConfig,
    options: RequestOptions = {},
  ): Promise<AxiosResponse<T>> {
    const configuredBranchId = this.configService.getOrThrow<
      AppConfig['chatbotApi']['branchId']
    >('chatbotApi.branchId');
    const branchId = options.branchId ?? configuredBranchId;

    if (branchId !== configuredBranchId) {
      throw new BranchMismatchError(configuredBranchId, branchId);
    }

    const requestConfig = this.buildAuthedRequestConfig(config);

    const maxAttempts = options.retryable ? MAX_GET_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await lastValueFrom(
          this.httpService.request<T>(requestConfig),
        );

        return response;
      } catch (error) {
        if (
          this.shouldRetry(requestConfig.method, error, attempt, maxAttempts)
        ) {
          await this.sleep(this.getBackoffDelay(attempt));
          continue;
        }

        throw this.mapError(
          error,
          config.url === '/chatbot-api/checkouts' ||
            config.url === '/chatbot-api/checkouts/status',
        );
      }
    }

    throw new UpstreamError('Chatbot API request failed after retries', null);
  }

  private shouldRetry(
    method: AxiosRequestConfig['method'],
    error: unknown,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if ((method ?? 'GET').toUpperCase() !== 'GET' || attempt >= maxAttempts) {
      return false;
    }

    const maybeAxiosError = error as {
      response?: {
        status?: number;
      };
      code?: string;
    };

    const status = maybeAxiosError.response?.status;

    if (typeof status === 'number') {
      return status >= 500;
    }

    return (
      typeof maybeAxiosError.code === 'string' || !maybeAxiosError.response
    );
  }

  private getBackoffDelay(attempt: number): number {
    return INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
  }

  private mapError(error: unknown, checkout = false): Error {
    const maybeAxiosError = error as {
      response?: {
        status?: number;
        headers?: Record<string, string | string[] | undefined>;
        data?: unknown;
      };
      message?: string;
    };
    const status = maybeAxiosError.response?.status;
    const responseBody = maybeAxiosError.response?.data;
    // Q3 errorCode passthrough: populate `errorCode` from `responseBody.error`
    // (verbatim, no transformation). `null` when the body is missing, not
    // JSON, or has no string `error` field (ADR-1 / ADR-2).
    const code =
      typeof responseBody === 'object' && responseBody !== null
        ? (responseBody as { code?: unknown }).code
        : null;
    const errorCode =
      checkout && typeof code === 'string' && code.length > 0
        ? code
        : extractErrorCode(responseBody);

    switch (status) {
      case 401:
        return new AuthError(
          'Chatbot API authentication failed',
          status,
          responseBody,
          errorCode,
        );
      case 403:
        return new ForbiddenError(
          'Chatbot API request was forbidden',
          status,
          responseBody,
          errorCode,
        );
      case 404:
        return new NotFoundError(
          'Chatbot API resource was not found',
          status,
          responseBody,
          errorCode,
        );
      case 429:
        return new RateLimitError(
          this.parseRetryAfter(maybeAxiosError.response?.headers),
          responseBody,
          errorCode,
        );
      default:
        if (typeof status === 'number' && status >= 500) {
          return new UpstreamError(
            'Chatbot API upstream failure',
            status,
            responseBody,
            errorCode,
          );
        }

        return new UpstreamError(
          maybeAxiosError.message ?? 'Chatbot API request failed',
          status ?? null,
          responseBody,
          errorCode,
        );
    }
  }

  private parseRetryAfter(
    headers?: Record<string, string | string[] | undefined>,
  ): number | null {
    const rawValue = headers?.['retry-after'];
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      return null;
    }

    return Math.max(0, parsed);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * The status, scoped `code` and Retry-After of a mapped HTTP error, or null
 * for a transport failure (no status). The scoped `{statusCode, code}`
 * envelope wins over a NestJS `error` label such as `"Conflict"`.
 */
function documentedFailure(error: unknown): {
  status: number;
  code: string | null;
  body: unknown;
  retryAfterSeconds: number | null;
} | null {
  if (!(error instanceof ChatbotApiError) || error.statusCode === null)
    return null;
  const body = error.responseBody;
  const scoped =
    typeof body === 'object' && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  return {
    status: error.statusCode,
    code:
      typeof scoped === 'string' && scoped !== '' ? scoped : error.errorCode,
    body,
    retryAfterSeconds:
      error instanceof RateLimitError ? error.retryAfterSeconds : null,
  };
}

function numberField(body: unknown, key: string): number | null {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[key]
      : undefined;
  return Number.isSafeInteger(value) ? (value as number) : null;
}

/** The backend's validation message (a string or class-validator list). */
function messageField(body: unknown): string | null {
  const value =
    typeof body === 'object' && body !== null
      ? (body as { message?: unknown }).message
      : undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((m) => typeof m === 'string'))
    return value.join('; ');
  return null;
}

/** A unit 9 request failure reduced to the facts the outbox needs (S6). */
interface MirrorRawFailure {
  status: number | null;
  code: string | null;
  body: unknown;
  retryAfterSeconds: number | null;
  transportCode: string | null;
}

/** A response header as one string (axios lowercases Node header names). */
function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const raw = (headers as Record<string, unknown>)[name];
  const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** The (unsanitized) `filename` of a `Content-Disposition` value. */
function contentDispositionFilename(
  disposition: string | undefined,
): string | undefined {
  if (disposition === undefined) return undefined;
  const quoted = /filename="([^"]*)"/i.exec(disposition);
  if (quoted !== null) return quoted[1];
  const bare = /filename=([^;]+)/i.exec(disposition);
  return bare === null ? undefined : bare[1].trim();
}

/**
 * A streamed (`responseType: 'stream'`) request that failed carries its error
 * body as an unread stream: read at most 4 KiB of it (bounded in time), parse
 * the scoped `{statusCode, code, message}` envelope and release the stream.
 * Anything unreadable leaves `code` null; a non-stream body is left as is.
 */
async function readStreamedErrorBody(
  failure: MirrorRawFailure,
): Promise<MirrorRawFailure> {
  const stream = failure.body;
  if (!(stream instanceof Readable)) return failure;
  let text = '';
  try {
    const read = (async () => {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array | string);
        size += buffer.length;
        if (size > STREAMED_ERROR_BODY_MAX_BYTES) break;
        chunks.push(buffer);
      }
      return size > STREAMED_ERROR_BODY_MAX_BYTES
        ? ''
        : Buffer.concat(chunks).toString('utf8');
    })();
    text = await Promise.race([
      read,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve(''), STREAMED_ERROR_BODY_READ_MS).unref();
      }),
    ]);
  } catch {
    text = '';
  } finally {
    stream.destroy();
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const scoped =
    typeof body === 'object' && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  return {
    ...failure,
    body,
    code: typeof scoped === 'string' && scoped !== '' ? scoped : null,
  };
}

const TIMEOUT_TRANSPORT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);

/** Route-independent reactions (S4): 400, 401/403, 429, 5xx/transport, a
 *  too-large body; anything else is UNEXPECTED (park, do not loop). */
function classifyMirrorFailure(
  failure: MirrorRawFailure,
): ConversationMirrorCommonFailure {
  const { status, code } = failure;
  if (status === null)
    return {
      kind: 'RETRYABLE',
      cause:
        failure.transportCode !== null &&
        TIMEOUT_TRANSPORT_CODES.has(failure.transportCode)
          ? 'timeout'
          : 'network',
      status: null,
      retryAfterSeconds: null,
    };
  if (status === 400)
    return {
      kind: 'VALIDATION_ERROR',
      message: messageField(failure.body),
      local: false,
    };
  if (status === 401) return { kind: 'UNAUTHORIZED' };
  if (status === 403) return { kind: 'FORBIDDEN', code };
  if (status === 429)
    return {
      kind: 'RATE_LIMITED',
      retryAfterSeconds: failure.retryAfterSeconds,
    };
  if (status === 413 && code === 'BODY_TOO_LARGE')
    return { kind: 'BODY_TOO_LARGE' };
  if (status >= 500)
    return {
      kind: 'RETRYABLE',
      cause: 'http_5xx',
      status,
      retryAfterSeconds: failure.retryAfterSeconds,
    };
  return { kind: 'UNEXPECTED', status, code };
}

/** Module-level flag so the legacy-omission warning logs at most once. */
let discountCentsWarned = false;

/**
 * Pull the backend envelope's `error` field into a typed string code (ADR-1).
 * Returns `null` when the body is not an object, has no `error` field, or
 * the `error` is not a non-empty string (ADR-2 — verbatim, no transforms).
 */
function extractErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const envelope = body as { error?: unknown; code?: unknown };
  // Older routes keep the `{error}` field and its precedence (ADR-1).
  const legacy = envelope.error;
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }
  // Human-decision routes use the scoped `{statusCode,code,message}` envelope.
  const scoped = envelope.code;
  return typeof scoped === 'string' && scoped.length > 0 ? scoped : null;
}
