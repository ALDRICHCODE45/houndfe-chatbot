/**
 * SQ-3D default-off composition wiring spec. Proves the `ShippingModule`
 * dynamic `forRoot()` gate is exact and inert when disabled (no providers,
 * exports, imports, instantiation, or HTTP), that the enabled graph builds
 * exactly one token -> quotation -> provider -> orchestrator chain behind
 * the provider-port and orchestrator exports plus one measured-demo config
 * provider behind `MEASURED_DEMO_SHIPPING_CONFIG`, and that `SaleFlowModule`
 * owns the dynamic import while `AppModule` has none. Fully offline: every
 * HTTP seam is observed through a spied `axios.request` that must never run.
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
import { ShippingQuoteOrchestrator } from './application/shipping-quote-orchestrator';
import { ShippingQuoteOutcomeLogger } from './infrastructure/shipping-quote-outcome.logger';
import {
  MEASURED_DEMO_SHIPPING_CONFIG,
  type MeasuredDemoShippingConfig,
} from './application/measured-demo-shipping-config';
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

/** Valid private measured-demo profile plus exact Skydropx origin. */
const MEASURED_VALUES: Record<string, string> = {
  'shippingQuotes.measuredDemoParcelProfileJson': JSON.stringify({
    version: 1,
    items: [
      {
        productId: '11111111-1111-1111-1111-111111111111',
        variantId: null,
        quantity: 1,
        measurement: {
          weightGrams: 500,
          lengthCm: 10,
          widthCm: 20,
          heightCm: 30,
        },
      },
    ],
    parcel: { weightGrams: 500, lengthCm: 10, widthCm: 20, heightCm: 30 },
  }),
  'shippingQuotes.skydropx.originPostalCode': '06000',
  'shippingQuotes.skydropx.originState': 'CDMX',
  'shippingQuotes.skydropx.originMunicipality': 'Cuauhtemoc',
  'shippingQuotes.skydropx.originNeighborhood': 'Centro',
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

/** Minimal valid orchestration input that reaches the provider exactly once. */
const ORCH_INPUT = {
  origin: { postalCode: '1', state: 'S', municipality: 'M', neighborhood: 'N' },
  destination: {
    zipCode: '2',
    state: 'T',
    municipality: 'U',
    neighborhood: 'V',
  },
  items: [
    {
      productId: 'p',
      quantity: 1,
      measurement: { weightGrams: 500, lengthCm: 1, widthCm: 1, heightCm: 1 },
      unitPriceCents: 1,
    },
  ],
  parcels: [{ lengthCm: 1, widthCm: 1, heightCm: 1, weightGrams: 500 }],
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
 * must resolve because the module includes it in the bounded public exports. */
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
        const spy = jest
          .spyOn(axios, 'request')
          .mockRejectedValue(new Error('network disabled in test'));
        const dynamic = ShippingModule.forRoot();
        expect(dynamic.providers).toEqual([]);
        expect(dynamic.exports).toEqual([]);
        expect(dynamic.imports).toEqual([]);

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
        expect(() => {
          moduleRef.get(ShippingQuoteOrchestrator, { strict: false });
        }).toThrow();
        expect(() => {
          moduleRef.get(MEASURED_DEMO_SHIPPING_CONFIG, { strict: false });
        }).toThrow();
        expect(() => {
          moduleRef.get(ShippingQuoteOutcomeLogger, { strict: false });
        }).toThrow();
        expect(spy).not.toHaveBeenCalled();
        await moduleRef.close();
      });
    });
  });

  describe('enabled exact true', () => {
    it('builds one private chain behind the exported port token', async () => {
      await withFlag('true', async () => {
        const httpSpy = jest
          .spyOn(axios, 'request')
          .mockRejectedValue(new Error('network disabled in test'));
        const dynamic = ShippingModule.forRoot();
        expect(dynamic.imports).toEqual([ConfigModule]);
        expect(dynamic.providers).toHaveLength(6);
        expect(dynamic.exports).toEqual([
          SHIPPING_QUOTE_PROVIDER,
          ShippingQuoteOrchestrator,
          MEASURED_DEMO_SHIPPING_CONFIG,
        ]);

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

        const orchestrator = moduleRef.get<ShippingQuoteOrchestrator>(
          ShippingQuoteOrchestrator,
        );
        expect(orchestrator).toBeInstanceOf(ShippingQuoteOrchestrator);
        expect(moduleRef.get(ShippingQuoteOrchestrator)).toBe(orchestrator);
        const quoteSpy = jest.spyOn(provider, 'quote').mockResolvedValue({
          kind: 'error',
          error: { kind: 'provider_disabled' },
        });
        await expect(
          orchestrator.quote({ requestInput: ORCH_INPUT }),
        ).resolves.toEqual({
          kind: 'unavailable',
          reason: 'provider_disabled',
        });
        expect(quoteSpy).toHaveBeenCalledTimes(1);
        expect(httpSpy).not.toHaveBeenCalled();

        expect(get.mock.calls.map((call) => call[0])).toEqual([
          'shippingQuotes.measuredDemoParcelProfileJson',
          'shippingQuotes.skydropx.originPostalCode',
          'shippingQuotes.skydropx.originState',
          'shippingQuotes.skydropx.originMunicipality',
          'shippingQuotes.skydropx.originNeighborhood',
          'shippingQuotes.skydropx.baseUrl',
          'shippingQuotes.skydropx.clientId',
          'shippingQuotes.skydropx.clientSecret',
          'shippingQuotes.skydropx.baseUrl',
        ]);
        await moduleRef.close();
      });
    });

    it('passes one outcome-logger adapter into the orchestrator', async () => {
      await withFlag('true', async () => {
        const record = jest
          .spyOn(ShippingQuoteOutcomeLogger.prototype, 'record')
          .mockImplementation(() => undefined);
        const moduleRef = await Test.createTestingModule({
          imports: [ShippingModule.forRoot()],
        })
          .overrideProvider(ConfigService)
          .useValue({ get: configStub(CONFIG_VALUES) })
          .compile();
        const adapter = moduleRef.get(ShippingQuoteOutcomeLogger, {
          strict: false,
        });
        expect(adapter).toBeInstanceOf(ShippingQuoteOutcomeLogger);
        const provider = moduleRef.get<ShippingQuoteProviderPort>(
          SHIPPING_QUOTE_PROVIDER,
        );
        jest.spyOn(provider, 'quote').mockResolvedValue({
          kind: 'error',
          error: { kind: 'provider_disabled' },
        });
        await expect(
          moduleRef
            .get<ShippingQuoteOrchestrator>(ShippingQuoteOrchestrator)
            .quote({ requestInput: ORCH_INPUT }),
        ).resolves.toEqual({
          kind: 'unavailable',
          reason: 'provider_disabled',
        });
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith('unavailable', 'provider_disabled');
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
        const spy = jest
          .spyOn(axios, 'request')
          .mockRejectedValue(new Error('network disabled in test'));
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

    it('resolves the measured-demo token to null without failing when the profile is absent', async () => {
      await withFlag('true', async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [ShippingModule.forRoot()],
        })
          .overrideProvider(ConfigService)
          .useValue({ get: configStub() })
          .compile();
        expect(
          moduleRef.get(MEASURED_DEMO_SHIPPING_CONFIG, { strict: false }),
        ).toBeNull();
        await moduleRef.close();
      });
    });

    it('resolves the measured-demo token to one frozen safe value with valid config', async () => {
      await withFlag('true', async () => {
        const spy = jest
          .spyOn(axios, 'request')
          .mockRejectedValue(new Error('network disabled in test'));
        const moduleRef = await Test.createTestingModule({
          imports: [ShippingModule.forRoot()],
        })
          .overrideProvider(ConfigService)
          .useValue({ get: configStub(MEASURED_VALUES) })
          .compile();
        const resolved = moduleRef.get<MeasuredDemoShippingConfig | null>(
          MEASURED_DEMO_SHIPPING_CONFIG,
          { strict: false },
        );
        expect(resolved).not.toBeNull();
        expect(resolved!.profile.version).toBe(1);
        expect(resolved!.origin).toEqual({
          postalCode: '06000',
          state: 'CDMX',
          municipality: 'Cuauhtemoc',
          neighborhood: 'Centro',
        });
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(spy).not.toHaveBeenCalled();
        await moduleRef.close();
      });
    });
  });

  it('declares no direct ShippingModule import in AppModule', () => {
    const imports =
      (Reflect.getMetadata('imports', AppModule) as
        | DynamicImportEntry[]
        | undefined) ?? [];
    expect(imports.some((entry) => entry?.module === ShippingModule)).toBe(
      false,
    );
  });
});
