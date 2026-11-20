import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { lastValueFrom } from 'rxjs';
import type { AppConfig } from '../../config/configuration';
import {
  AuthError,
  ChatbotApiError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { CHATBOT_API_SLEEP } from '../../chatbot-api/infrastructure/chatbot-api-http.client';
import {
  parseBackorderEnvelope,
  parseBackorderList,
  type BackorderBot,
  type BackorderClient,
  type CreateBackorderInput,
  type CreateBackorderResult,
  type ListBackordersQuery,
} from '../domain/backorder';

type SleepFn = (milliseconds: number) => Promise<void>;

const MAX_GET_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 100;
/** Backend: key per sucursal, 1–200 chars trimmed. */
const KEY_MAX_LENGTH = 200;
/** Same default as the rest of the chatbot-api calls. */
const TIMEOUT_MS = 10_000;

/**
 * `/chatbot-api/backorders` over HTTP (backend T1). It talks to the same
 * service with the same credential, branch header, safe-GET retry policy and
 * error classes as `ChatbotApiHttpClient`; the request helpers of that class
 * are private, so the few lines of transport are repeated here (the error
 * classes and the sleep seam are imported). POST and cancel are single
 * attempt: a timeout is an unknown outcome the caller retries with the SAME
 * idempotency key.
 */
@Injectable()
export class BackorderHttpClient implements BackorderClient {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CHATBOT_API_SLEEP)
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  async createBackorder(
    input: CreateBackorderInput,
    idempotencyKey: string,
  ): Promise<CreateBackorderResult> {
    const key = idempotencyKey.trim();
    if (key === '' || key.length > KEY_MAX_LENGTH)
      throw new ChatbotApiError(
        'Backorder idempotency key is invalid',
        null,
        undefined,
        'INVALID_IDEMPOTENCY_KEY',
      );
    const response = await this.send({
      method: 'POST',
      url: '/chatbot-api/backorders',
      data: input,
      headers: { 'X-Idempotency-Key': key },
    });
    const backorder = this.accept(response, [200, 201], parseBackorderEnvelope);
    return { created: response.status === 201, backorder };
  }

  async getBackorder(id: string): Promise<BackorderBot> {
    const response = await this.send(
      {
        method: 'GET',
        url: `/chatbot-api/backorders/${encodeURIComponent(id)}`,
      },
      true,
    );
    return this.accept(response, [200], parseBackorderEnvelope);
  }

  async listBackorders(
    query: ListBackordersQuery = {},
  ): Promise<BackorderBot[]> {
    const params = Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined),
    );
    const response = await this.send(
      { method: 'GET', url: '/chatbot-api/backorders', params },
      true,
    );
    return this.accept(response, [200], parseBackorderList);
  }

  async cancelBackorder(id: string, reason?: string): Promise<BackorderBot> {
    const response = await this.send({
      method: 'POST',
      url: `/chatbot-api/backorders/${encodeURIComponent(id)}/cancel`,
      data: reason === undefined ? {} : { reason },
    });
    return this.accept(response, [200], parseBackorderEnvelope);
  }

  private accept<T>(
    response: AxiosResponse<unknown>,
    statuses: number[],
    parse: (body: unknown) => T | null,
  ): T {
    const parsed = statuses.includes(response.status)
      ? parse(response.data)
      : null;
    if (parsed === null)
      throw new UpstreamError(
        'Chatbot API backorder response was invalid',
        response.status,
        response.data,
        extractErrorCode(response.data),
      );
    return parsed;
  }

  private async send(
    config: AxiosRequestConfig,
    retryable = false,
  ): Promise<AxiosResponse<unknown>> {
    const requestConfig: AxiosRequestConfig = {
      timeout: TIMEOUT_MS,
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
    const attempts = retryable ? MAX_GET_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await lastValueFrom(
          this.httpService.request<unknown>(requestConfig),
        );
      } catch (error) {
        if (attempt < attempts && shouldRetry(error)) {
          await this.sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        throw mapError(error);
      }
    }
    throw new UpstreamError('Chatbot API request failed after retries', null);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Safe-GET policy: network failures and 5xx only. */
function shouldRetry(error: unknown): boolean {
  const maybe = error as { response?: { status?: number }; code?: string };
  const status = maybe.response?.status;
  if (typeof status === 'number') return status >= 500;
  return typeof maybe.code === 'string' || !maybe.response;
}

function extractErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { error?: unknown; code?: unknown };
  if (typeof envelope.error === 'string' && envelope.error.length > 0)
    return envelope.error;
  return typeof envelope.code === 'string' && envelope.code.length > 0
    ? envelope.code
    : null;
}

function mapError(error: unknown): Error {
  const maybe = error as {
    response?: {
      status?: number;
      headers?: Record<string, string | string[] | undefined>;
      data?: unknown;
    };
    message?: string;
  };
  const status = maybe.response?.status;
  const body = maybe.response?.data;
  const code = extractErrorCode(body);
  switch (status) {
    case 401:
      return new AuthError(
        'Chatbot API authentication failed',
        status,
        body,
        code,
      );
    case 403:
      return new ForbiddenError(
        'Chatbot API request was forbidden',
        status,
        body,
        code,
      );
    case 404:
      return new NotFoundError(
        'Chatbot API resource was not found',
        status,
        body,
        code,
      );
    case 429:
      return new RateLimitError(
        parseRetryAfter(maybe.response?.headers),
        body,
        code,
      );
    default:
      return new UpstreamError(
        typeof status === 'number' && status >= 500
          ? 'Chatbot API upstream failure'
          : (maybe.message ?? 'Chatbot API request failed'),
        status ?? null,
        body,
        code,
      );
  }
}

function parseRetryAfter(
  headers?: Record<string, string | string[] | undefined>,
): number | null {
  const raw = headers?.['retry-after'];
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}
