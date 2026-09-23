/**
 * SQ-3D default-off shipping-quote composition root.
 *
 * `ShippingModule.forRoot()` is a static dynamic-module factory consumed once
 * by `SaleFlowModule`. SQ-5A moved it out of the direct `AppModule` imports so
 * the whole application graph keeps exactly one dynamic shipping import
 * (reachable from `AppModule` transitively through `LlmAgentModule`).
 * The enable/disable decision is the exact, case-sensitive
 * `process.env.SHIPPING_QUOTES_ENABLED === 'true'` gate, mirrored from
 * `configuration.ts`, and is evaluated when `forRoot()` runs (module
 * metadata build time, before boot) — never toggled at live runtime; a
 * change takes effect by graceful restart/redeploy.
 *
 * Disabled: the module declares `imports: []`, `providers: []` and
 * `exports: []`, so the `SHIPPING_QUOTE_PROVIDER` and
 * `MEASURED_DEMO_SHIPPING_CONFIG` tokens, the concrete Skydropx clients, and
 * `ShippingQuoteOrchestrator` are never registered, instantiated, or exported.
 *
 * Enabled: the module composes exactly one singleton chain
 * `SkydropxTokenClient -> SkydropxQuotationClient -> SkydropxShippingQuoteProvider`
 * plus one singleton `ShippingQuoteOrchestrator` built from that exported
 * provider and one private `ShippingQuoteOutcomeLogger` redacted outcome
 * adapter, and one `MEASURED_DEMO_SHIPPING_CONFIG` provider that resolves the
 * optional private measured-demo profile and exact origin through
 * `resolveMeasuredDemoShippingConfig`. It exports exactly
 * `SHIPPING_QUOTE_PROVIDER`, `ShippingQuoteOrchestrator`, and
 * `MEASURED_DEMO_SHIPPING_CONFIG`. Configuration is read through the injected
 * `ConfigService`; a missing or non-string value becomes an empty string so
 * the clients fail closed (`provider_disabled`) instead of throwing or
 * logging, and an absent or invalid measured-demo profile resolves the config
 * token to `null` without failing boot. Module construction performs no I/O.
 */
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ShippingQuoteOrchestrator } from './application/shipping-quote-orchestrator';
import {
  MEASURED_DEMO_SHIPPING_CONFIG,
  resolveMeasuredDemoShippingConfig,
} from './application/measured-demo-shipping-config';
import {
  SHIPPING_QUOTE_PROVIDER,
  type ShippingQuoteProviderPort,
} from './domain/shipping-quote.port';
import { SkydropxQuotationClient } from './infrastructure/skydropx-quotation.client';
import { SkydropxShippingQuoteProvider } from './infrastructure/skydropx-shipping-quote.provider';
import { SkydropxTokenClient } from './infrastructure/skydropx-token.client';
import { ShippingQuoteOutcomeLogger } from './infrastructure/shipping-quote-outcome.logger';

/** Bounded OAuth token request timeout (positive safe integer). */
export const SKYDROPX_TOKEN_TIMEOUT_MS = 10_000;
/** Bounded create/poll timeout; the poll reader caps at 60_000 ms. */
export const SKYDROPX_QUOTATION_TIMEOUT_MS = 15_000;

/** Exact, case-sensitive default-off gate matching `configuration.ts`. */
const isShippingQuotesEnabled = (): boolean =>
  process.env.SHIPPING_QUOTES_ENABLED === 'true';

/** Read one config path as a string; missing/non-string becomes '' (fail closed). */
const readString = (config: ConfigService, key: string): string => {
  const value: unknown = config.get(key);
  return typeof value === 'string' ? value : '';
};

@Module({})
export class ShippingModule {
  static forRoot(): DynamicModule {
    if (!isShippingQuotesEnabled()) {
      return {
        module: ShippingModule,
        imports: [],
        providers: [],
        exports: [],
      };
    }
    return {
      module: ShippingModule,
      imports: [ConfigModule],
      providers: [
        {
          provide: MEASURED_DEMO_SHIPPING_CONFIG,
          inject: [ConfigService],
          useFactory: (config: ConfigService) =>
            resolveMeasuredDemoShippingConfig(config),
        },
        {
          provide: SkydropxTokenClient,
          inject: [ConfigService],
          useFactory: (config: ConfigService) =>
            new SkydropxTokenClient({
              baseUrl: readString(config, 'shippingQuotes.skydropx.baseUrl'),
              clientId: readString(config, 'shippingQuotes.skydropx.clientId'),
              clientSecret: readString(
                config,
                'shippingQuotes.skydropx.clientSecret',
              ),
              timeoutMs: SKYDROPX_TOKEN_TIMEOUT_MS,
            }),
        },
        {
          provide: SkydropxQuotationClient,
          inject: [ConfigService, SkydropxTokenClient],
          useFactory: (config: ConfigService, tokens: SkydropxTokenClient) =>
            new SkydropxQuotationClient(
              {
                baseUrl: readString(config, 'shippingQuotes.skydropx.baseUrl'),
                timeoutMs: SKYDROPX_QUOTATION_TIMEOUT_MS,
              },
              tokens,
            ),
        },
        {
          provide: SHIPPING_QUOTE_PROVIDER,
          inject: [SkydropxQuotationClient],
          useFactory: (
            client: SkydropxQuotationClient,
          ): ShippingQuoteProviderPort =>
            new SkydropxShippingQuoteProvider(client),
        },
        ShippingQuoteOutcomeLogger,
        {
          provide: ShippingQuoteOrchestrator,
          inject: [SHIPPING_QUOTE_PROVIDER, ShippingQuoteOutcomeLogger],
          useFactory: (
            provider: ShippingQuoteProviderPort,
            telemetry: ShippingQuoteOutcomeLogger,
          ): ShippingQuoteOrchestrator =>
            new ShippingQuoteOrchestrator(provider, telemetry),
        },
      ],
      // prettier-ignore
      exports: [SHIPPING_QUOTE_PROVIDER, ShippingQuoteOrchestrator, MEASURED_DEMO_SHIPPING_CONFIG],
    };
  }
}
