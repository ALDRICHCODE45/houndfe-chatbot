import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig } from 'axios';
import { lastValueFrom } from 'rxjs';
import type { AppConfig } from '../../config/configuration';
import {
  ChatbotApiClient,
} from '../domain/chatbot-api.client';
import type { CatalogItemResponse, StockCheckResponse } from '../domain/dtos/catalog.dto';
import type {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from '../domain/dtos/customers.dto';
import type { CartEvaluationResult, CartItemInput } from '../domain/dtos/pricing.dto';
import type {
  AttachReceiptInput,
  AttachReceiptResponse,
  BotSaleResponse,
  CreateSaleInput,
  OrderHistoryResponse,
  UpdateDeliveryInput,
} from '../domain/dtos/sales.dto';
import {
  AuthError,
  BranchMismatchError,
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
        url: `/chatbot-api/catalog/${productId}/stock`,
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

  getCustomerByPhone(cc: string, phone: string): Promise<CustomerLookupResponse> {
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

  createSale(dto: CreateSaleInput, idempotencyKey: string): Promise<BotSaleResponse> {
    return this.request<BotSaleResponse>({
      method: 'POST',
      url: '/chatbot-api/sales',
      data: dto,
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
    });
  }

  attachReceipt(saleId: string, dto: AttachReceiptInput): Promise<AttachReceiptResponse> {
    return this.request<AttachReceiptResponse>({
      method: 'POST',
      url: `/chatbot-api/sales/${saleId}/receipts`,
      data: dto,
    });
  }

  async updateDelivery(saleId: string, dto: UpdateDeliveryInput): Promise<void> {
    await this.request<Record<string, never>>({
      method: 'PATCH',
      url: `/chatbot-api/sales/${saleId}/delivery`,
      data: dto,
    });
  }

  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]> {
    return this.request<OrderHistoryResponse[]>(
      {
        method: 'GET',
        url: `/chatbot-api/customers/by-phone/${phone}/orders`,
        params: {
          phoneCountryCode: cc,
        },
      },
      { retryable: true },
    );
  }

  private async request<T>(config: AxiosRequestConfig, options: RequestOptions = {}): Promise<T> {
    const configuredBranchId = this.configService.getOrThrow<AppConfig['chatbotApi']['branchId']>(
      'chatbotApi.branchId',
    );
    const branchId = options.branchId ?? configuredBranchId;

    if (branchId !== configuredBranchId) {
      throw new BranchMismatchError(configuredBranchId, branchId);
    }

    const requestConfig: AxiosRequestConfig = {
      ...config,
      baseURL: this.configService.getOrThrow<AppConfig['chatbotApi']['baseUrl']>('chatbotApi.baseUrl'),
      headers: {
        ...(config.headers ?? {}),
        Authorization: `Bearer ${this.configService.getOrThrow<AppConfig['chatbotApi']['serviceKey']>('chatbotApi.serviceKey')}`,
        'X-Branch-Id': configuredBranchId,
      },
    };

    const maxAttempts = options.retryable ? MAX_GET_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await lastValueFrom(this.httpService.request<T>(requestConfig));

        return response.data;
      } catch (error) {
        if (this.shouldRetry(requestConfig.method, error, attempt, maxAttempts)) {
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

    return typeof maybeAxiosError.code === 'string' || !maybeAxiosError.response;
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

    switch (status) {
      case 401:
        return new AuthError('Chatbot API authentication failed', status, responseBody);
      case 403:
        return new ForbiddenError('Chatbot API request was forbidden', status, responseBody);
      case 404:
        return new NotFoundError('Chatbot API resource was not found', status, responseBody);
      case 429:
        return new RateLimitError(this.parseRetryAfter(maybeAxiosError.response?.headers), responseBody);
      default:
        if (typeof status === 'number' && status >= 500) {
          return new UpstreamError('Chatbot API upstream failure', status, responseBody);
        }

        return new UpstreamError(
          maybeAxiosError.message ?? 'Chatbot API request failed',
          status ?? null,
          responseBody,
        );
    }
  }

  private parseRetryAfter(
    headers?: Record<string, string | string[] | undefined>,
  ): number | null {
    const rawValue = headers?.['retry-after'];
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
