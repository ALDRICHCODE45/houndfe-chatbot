/**
 * SQ-3D default-off composition wiring spec. Proves the `ShippingModule`
 * dynamic `forRoot()` gate is exact and inert when disabled (no providers,
 * exports, imports, instantiation, or HTTP), that the enabled graph builds
 * exactly one token -> quotation -> provider chain behind only the
 * `SHIPPING_QUOTE_PROVIDER` export, and that `AppModule` embeds that dynamic
 * module without booting real config or network. Fully offline: every HTTP
 * seam is observed through a spied `axios.request` that must never run.
 */
import axios from 'axios';
import { Inject, Injectable, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  SHIPPING_QUOTE_PROVIDER,
  type ShippingQuoteProviderPort,
} from './domain/shipping-quote.port';
import type { ShippingQuoteRequest } from './domain/shipping-quote.request';
import { SkydropxQuotationClient } from './infrastructure/skydropx-quotation.client';
import { SkydropxShippingQuoteProvider } from './infrastructure/skydropx-shipping-quote.provider';
import { SkydropxTokenClient } from './infrastructure/skydropx-token.client';
import {
  ShippingModule,
  SKYDROPX_QUOTATION_TIMEOUT_MS,
  SKYDROPX_TOKEN_TIMEOUT_MS,
} from './shipping.module';
import { AppModule } from '../app.module';

/** Stub the app config module so importing `AppModule` never boots the real
 * `ConfigModule`/env validation or reads a `.env` file. Hoisted by ts-jest,
 * so it applies before the `AppModule` import above is evaluated. */
jest.mock('../config/config.module', () => ({
  AppConfigModule: {
    forRoot: () => ({
      module: class AppConfigStubModule {},
      providers: [],
      exports: [],
    }),
  },
}));

type DynamicImportEntry = { module?: unknown; providers?: unknown };

const CONFIG_VALUES: Record<string, string> = {
  'shippingQuotes.skydropx.baseUrl': 'https://api-pro.skydropx.com',
  'shippingQuotes.skydropx.clientId': 'client-id',
  'shippingQuotes.skydropx.clientSecret': 'client-secret',
};

const configStub = (values: Record<string, string | undefined> = {}) =>
  jest.fn((key: string): string | undefined => values[key]);

const withFlag = async (
  value: string | undefined,
  run: () => void | Promise<void>,
): Promise<void> => {
  const saved = process.env.SHIPPING_QUOTES_ENABLED;
  if (value === undefined) delete process.env.SHIPPING_QUOTES_ENABLED;
  else process.env.SHIPPING_QUOTES_ENABLED = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.SHIPPING_QUOTES_ENABLED;
    else process.env.SHIPPING_QUOTES_ENABLED = saved;
  }
};

const VALID_REQUEST: ShippingQuoteRequest = {
  origin: {
    countryCode: 'MX',
    postalCode: '06000',
    state: 'Ciudad de Mexico',
    municipality: 'Cuauhtemoc',
    neighborhood: 'Centro',
  },
  destination: {
    countryCode: 'MX',
    postalCode: '44100',
    state: 'Jalisco',
    municipality: 'Guadalajara',
    neighborhood: 'Centro',
  },
  parcels: [{ lengthCm: 20, widthCm: 15, heightCm: 10, weightGrams: 1500 }],
};

@Injectable()
class PortConsumer {
  constructor(
    @Inject(SHIPPING_QUOTE_PROVIDER)
    readonly provider: ShippingQuoteProviderPort,
  ) {}
}

@Injectable()
class TokenClientConsumer {
  constructor(readonly client: SkydropxTokenClient) {}
}

/** Host consumer module that imports the enabled graph; the provider token
 * must resolve only because the module exports exactly that token. */
const portConsumerModule = (): DynamicModule => ({
  module: class PortConsumerHostModule {},
  imports: [ShippingModule.forRoot()],
  providers: [PortConsumer],
});

/** Host consumer module that must FAIL to see the private concrete clients. */
const tokenClientConsumerModule = (): DynamicModule => ({
  module: class TokenClientConsumerHostModule {},
  imports: [ShippingModule.forRoot()],
  providers: [TokenClientConsumer],
});

const compileConsumer = (consumer: DynamicModule, get: jest.Mock) =>
  Test.createTestingModule({ imports: [consumer] })
    .overrideProvider(ConfigService)
    .useValue({ get })
    .compile();

describe('ShippingModule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exports bounded positive timeout constants', () => {
    for (const value of [
      SKYDROPX_TOKEN_TIMEOUT_MS,
      SKYDROPX_QUOTATION_TIMEOUT_MS,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(SKYDROPX_TOKEN_TIMEOUT_MS).toBe(10_000);
    expect(SKYDROPX_QUOTATION_TIMEOUT_MS).toBe(15_000);
    expect(SKYDROPX_QUOTATION_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  describe('default-off gate', () => {
    it.each([
      { label: 'unset', value: undefined },
      { label: 'explicit false', value: 'false' },
      { label: 'uppercase TRUE', value: 'TRUE' },
      { label: 'padded value', value: ' true ' },
    ])('stays inert when $label', async ({ value }) => {
      await withFlag(value, async () => {
        const spy = jest.spyOn(axios, 'request');
        const dynamic = ShippingModule.forRoot();
        expect(dynamic.providers).toEqual([]);
        expect(dynamic.exports).toEqual([]);
        expect(dynamic.imports ?? []).toEqual([]);

        const moduleRef = await Test.createTestingModule({
          imports: [dynamic],
        }).compile();
        expect(() => {
          moduleRef.get(SHIPPING_QUOTE_PROVIDER, { strict: false });
        }).toThrow();
        expect(() => {
          moduleRef.get(SkydropxTokenClient, { strict: false });
        }).toThrow();
        expect(() => {
          moduleRef.get(SkydropxQuotationClient, { strict: false });
        }).toThrow();
        expect(spy).not.toHaveBeenCalled();
        await moduleRef.close();
      });
    });
  });

  describe('enabled exact true', () => {
    it('builds one private chain behind the exported port token', async () => {
      await withFlag('true', async () => {
        const dynamic = ShippingModule.forRoot();
        expect(dynamic.imports).toEqual([ConfigModule]);
        expect(dynamic.providers).toHaveLength(3);
        expect(dynamic.exports).toEqual([SHIPPING_QUOTE_PROVIDER]);

        const get = configStub(CONFIG_VALUES);
        const moduleRef = await Test.createTestingModule({
          imports: [dynamic],
        })
          .overrideProvider(ConfigService)
          .useValue({ get })
          .compile();

        const provider = moduleRef.get<ShippingQuoteProviderPort>(
          SHIPPING_QUOTE_PROVIDER,
        );
        expect(provider).toBeInstanceOf(SkydropxShippingQuoteProvider);
        expect(moduleRef.get(SHIPPING_QUOTE_PROVIDER)).toBe(provider);

        const token = moduleRef.get<SkydropxTokenClient>(SkydropxTokenClient, {
          strict: false,
        });
        const quotation = moduleRef.get<SkydropxQuotationClient>(
          SkydropxQuotationClient,
          { strict: false },
        );
        expect(token).toBeInstanceOf(SkydropxTokenClient);
        expect(quotation).toBeInstanceOf(SkydropxQuotationClient);
        expect(moduleRef.get(SkydropxTokenClient, { strict: false })).toBe(
          token,
        );
        expect(moduleRef.get(SkydropxQuotationClient, { strict: false })).toBe(
          quotation,
        );

        expect(get.mock.calls.map((call) => call[0])).toEqual([
          'shippingQuotes.skydropx.baseUrl',
          'shippingQuotes.skydropx.clientId',
          'shippingQuotes.skydropx.clientSecret',
          'shippingQuotes.skydropx.baseUrl',
        ]);
        await moduleRef.close();
      });
    });

    it('resolves the exported port in a consumer module', async () => {
      await withFlag('true', async () => {
        const moduleRef = await compileConsumer(
          portConsumerModule(),
          configStub(CONFIG_VALUES),
        );
        expect(moduleRef.get(PortConsumer).provider).toBeInstanceOf(
          SkydropxShippingQuoteProvider,
        );
        await moduleRef.close();
      });
    });

    it('keeps concrete clients private from consumer modules', async () => {
      await withFlag('true', async () => {
        await expect(
          compileConsumer(tokenClientConsumerModule(), configStub()),
        ).rejects.toThrow();
      });
    });

    it('fails closed with blank config and performs no construction I/O', async () => {
      await withFlag('true', async () => {
        const spy = jest.spyOn(axios, 'request');
        const moduleRef = await Test.createTestingModule({
          imports: [ShippingModule.forRoot()],
        })
          .overrideProvider(ConfigService)
          .useValue({ get: configStub() })
          .compile();

        const provider = moduleRef.get<ShippingQuoteProviderPort>(
          SHIPPING_QUOTE_PROVIDER,
        );
        await expect(provider.quote(VALID_REQUEST)).resolves.toEqual({
          kind: 'error',
          error: { kind: 'provider_disabled' },
        });
        expect(spy).not.toHaveBeenCalled();
        await moduleRef.close();
      });
    });
  });

  it('embeds the ShippingModule dynamic import in AppModule', () => {
    const imports =
      (Reflect.getMetadata('imports', AppModule) as
        | DynamicImportEntry[]
        | undefined) ?? [];
    const shipping = imports.filter(
      (entry) => entry?.module === ShippingModule,
    );
    expect(shipping).toHaveLength(1);
    expect(Array.isArray(shipping[0].providers)).toBe(true);
    expect(
      imports.some(
        (entry) =>
          (entry?.module as { name?: string } | undefined)?.name ===
          'AppConfigStubModule',
      ),
    ).toBe(true);
    expect(imports.some((entry) => entry?.module === AppModule)).toBe(false);
  });
});
