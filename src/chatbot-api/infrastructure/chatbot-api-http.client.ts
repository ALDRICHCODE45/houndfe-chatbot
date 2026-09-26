import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { lastValueFrom } from 'rxjs';
import type { AppConfig } from '../../config/configuration';
import { ChatbotApiClient } from '../domain/chatbot-api.client';
import type { AttachReceiptTransportOptions } from '../domain/chatbot-api.client';
import type {
  CatalogItemResponse,
  StockCheckResponse,
} from '../domain/dtos/catalog.dto';
import type {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from '../domain/dtos/customers.dto';
import type { PaymentDetail } from '../domain/dtos/payment-details.dto';
import type {
  CartEvaluationResult,
  CartItemInput,
} from '../domain/dtos/pricing.dto';
import type {
  AttachReceiptInput,
  AttachReceiptResponse,
  BotSaleResponse,
  BotSaleShippingInput,
  CancelSaleInput,
  CancelSaleResult,
  CreateSaleInput,
  OrderHistoryResponse,
  UpdateDeliveryInput,
} from '../domain/dtos/sales.dto';
import {
  CancelSaleInputSchema,
  CreateSaleInputSchema,
} from '../domain/dtos/sales.dto';
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
const DECISION_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHATBOT_API_SLEEP = Symbol('CHATBOT_API_SLEEP');

@Injectable()
export class ChatbotApiHttpClient implements ChatbotApiClient {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CHATBOT_API_SLEEP)
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  searchCatalog(q: string, limit?: number): Promise<CatalogItemResponse[]> {
    return this.request<CatalogItemResponse[]>(
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
  }

  getStock(productId: string): Promise<StockCheckResponse> {
    return this.request<StockCheckResponse>(
      {
        method: 'GET',
        url: `/chatbot-api/catalog/${encodeURIComponent(productId)}/stock`,
      },
      { retryable: true },
    );
  }

  evaluateCart(items: CartItemInput[]): Promise<CartEvaluationResult> {
    return this.request<CartEvaluationResult>({
      method: 'POST',
      url: '/chatbot-api/pricing/evaluate-cart',
      data: { items },
    });
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
    const shipping = parsed.shipping;
    // SQ-5E3: `shipping` is omitted entirely when absent/null, and its own
    // optional `quoteId` is omitted when absent/null (the backend rejects a
    // literal `null` on the wire). The conditional positive-`expectedTotalCents`
    // rule is already enforced by `CreateSaleInputSchema`.
    const wireShipping: BotSaleShippingInput | null = shipping
      ? {
          chargeCents: shipping.chargeCents,
          approvalId: shipping.approvalId,
          ...(typeof shipping.quoteId === 'string'
            ? { quoteId: shipping.quoteId }
            : {}),
        }
      : null;
    const wireDto: CreateSaleInput = {
      cashierUserId: parsed.cashierUserId,
      customerId: parsed.customerId,
      shippingAddressId: parsed.shippingAddressId ?? null,
      items: parsed.items,
      ...(typeof expectedTotalCents === 'number' ? { expectedTotalCents } : {}),
      ...(wireShipping ? { shipping: wireShipping } : {}),
    };
    return this.request<BotSaleResponse>({
      method: 'POST',
      url: '/chatbot-api/sales',
      data: wireDto,
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
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

  attachReceipt(
    saleId: string,
    dto: AttachReceiptInput,
    options: AttachReceiptTransportOptions = {},
  ): Promise<AttachReceiptResponse> {
    return this.requestAttachReceipt(
      {
        method: 'POST',
        url: `/chatbot-api/sales/${encodeURIComponent(saleId)}/receipts`,
        data: dto,
      },
      options,
    );
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

  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]> {
    return this.request<OrderHistoryResponse[]>(
      {
        method: 'GET',
        url: `/chatbot-api/customers/by-phone/${encodeURIComponent(phone)}/orders`,
        params: {
          phoneCountryCode: cc,
        },
      },
      { retryable: true },
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
   * Attachment-only (WU11B) transport: exactly one POST, no retries, no
   * sleeps. The timeout is owned by this client
   * (`receiptMedia.attachTimeoutMs`, forwarded as the Axios `timeout`) and
   * a caller-supplied `AbortSignal` is forwarded verbatim as the Axios
   * `signal`. Axios rejections keep flowing through `mapError()` with
   * status/body/errorCode evidence; only *fulfilled* responses with an
   * unexpected status or body are converted here to an `UpstreamError`
   * that keeps the same evidence — this error is thrown out of this
   * private seam and never re-mapped, so no evidence is lost.
   */
  private async requestAttachReceipt(
    config: AxiosRequestConfig,
    options: AttachReceiptTransportOptions,
  ): Promise<AttachReceiptResponse> {
    const timeoutMs = this.configService.getOrThrow<
      NonNullable<AppConfig['receiptMedia']['attachTimeoutMs']>
    >('receiptMedia.attachTimeoutMs');

    const requestConfig = this.buildAuthedRequestConfig({
      ...config,
      timeout: timeoutMs,
      signal: options.signal,
    });

    let response;
    try {
      response = await lastValueFrom(
        this.httpService.request<AttachReceiptResponse>(requestConfig),
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const body = response.data;
    const isValid =
      response.status === 201 &&
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { receiptId?: unknown }).receiptId === 'string' &&
      (body as { status?: unknown }).status === 'PENDING';

    if (!isValid) {
      throw new UpstreamError(
        'Chatbot API attach-receipt response was invalid',
        response.status,
        body,
        extractErrorCode(body),
      );
    }

    return body;
  }

  /**
   * Shared single-branch auth envelope: base URL + `Authorization` and
   * `X-Branch-Id` headers (ADR-16), applied identically to every
   * chatbot-api request including the attachment-only transport.
   */
  private buildAuthedRequestConfig(
    config: AxiosRequestConfig,
  ): AxiosRequestConfig {
    return {
      ...config,
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

        throw this.mapError(error);
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

  private mapError(error: unknown): Error {
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
    const errorCode = extractErrorCode(responseBody);

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
