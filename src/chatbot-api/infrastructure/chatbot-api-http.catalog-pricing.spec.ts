import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { UpstreamError } from '../domain/errors';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const PRODUCT = '0b6f2c0e-6a8e-4f7e-9f3a-2d1f6b9c4e11';
const stock = { status: 'available', quantity: 12 };
const catalogItem = {
  productId: PRODUCT,
  name: 'Croquetas Adulto 20 kg',
  brand: null,
  imageUrl: null,
  description: 'Bulto',
  price: {
    priceCents: 89900,
    fromPriceCents: null,
    promoPriceCents: null,
    promotionEvaluationStatus: 'needs_human_review',
  },
  stock,
  packageInfo: { weightGrams: null, dimensions: null },
  variants: [],
};
const stockCheck = {
  productId: PRODUCT,
  name: 'Croquetas',
  stock,
  variants: [],
};
const evaluation = {
  items: [
    {
      productId: PRODUCT,
      variantId: null,
      quantity: 1,
      unitPriceCents: 89900,
      originalPriceCents: 89900,
      finalPriceCents: 89900,
      appliedPromotionTitle: null,
      discountAmountCents: 0,
    },
  ],
  promotionEvaluationStatus: 'fully_evaluated',
  customerResolution: 'not_found',
};
const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

describe('catalog search, stock and evaluate-cart response parsing', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let warn: jest.SpiedFunction<Logger['warn']>;
  let client: ChatbotApiHttpClient;
  const calls = {
    search: (c: ChatbotApiHttpClient) => c.searchCatalog('croquetas'),
    stock: (c: ChatbotApiHttpClient) => c.getStock(PRODUCT),
    evaluate: (c: ChatbotApiHttpClient) =>
      c.evaluateCart([{ productId: PRODUCT, quantity: 1, unitPriceCents: 0 }], {
        phoneCountryCode: '52',
        phone: '5512345678',
      }),
  };
  const bodies = {
    search: [catalogItem],
    stock: stockCheck,
    evaluate: evaluation,
  };

  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    client = new ChatbotApiHttpClient(
      http,
      new ConfigService({
        chatbotApi: {
          baseUrl: 'https://example.invalid',
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      jest.fn().mockResolvedValue(undefined),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['search', 'stock', 'evaluate'] as const)(
    '%s returns the parsed body',
    async (name) => {
      request.mockReturnValue(of(response(bodies[name])));
      await expect(calls[name](client)).resolves.toEqual(bodies[name]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('evaluate accepts the backend 201 status', async () => {
    request.mockReturnValue(of(response(evaluation, 201)));
    await expect(calls.evaluate(client)).resolves.toEqual(evaluation);
  });

  it('strips unknown keys and warns once per key name without values', async () => {
    request.mockReturnValue(
      of(response([{ ...catalogItem, sku: 'SECRET-SKU' }])),
    );
    await expect(client.searchCatalog('a')).resolves.toEqual([catalogItem]);
    await client.searchCatalog('b');
    request.mockReturnValue(of(response({ ...stockCheck, sku: 'SECRET' })));
    await expect(client.getStock(PRODUCT)).resolves.toEqual(stockCheck);
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.map((args) => JSON.stringify(args));
    expect(logged.join()).not.toContain('SECRET');
    expect(logged[0]).toContain('[].sku');
    expect(logged[1]).toContain('sku');
  });

  it.each([
    ['search', { items: [] }],
    [
      'search',
      [{ ...catalogItem, stock: { status: 'in_stock', quantity: 1 } }],
    ],
    ['stock', { ...stockCheck, name: null }],
    ['stock', {}],
    ['evaluate', { ...evaluation, customerResolution: 'many' }],
    [
      'evaluate',
      { ...evaluation, items: [{ ...evaluation.items[0], quantity: 0 }] },
    ],
  ] as const)(
    '%s maps an invalid body to UpstreamError',
    async (name, body) => {
      request.mockReturnValue(of(response(body)));
      const error = await calls[name](client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toMatch(/response was invalid/);
      expect((error as UpstreamError).responseBody).toEqual(body);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['search', 'stock'] as const)(
    '%s rejects a non-200 success status',
    async (name) => {
      request.mockReturnValue(of(response(bodies[name], 204)));
      await expect(calls[name](client)).rejects.toBeInstanceOf(UpstreamError);
    },
  );
});
