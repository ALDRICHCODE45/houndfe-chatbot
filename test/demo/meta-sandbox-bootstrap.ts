import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpModule, HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import {
  WHATSAPP_SENDER,
  type WhatsappSenderPort,
} from '../../src/whatsapp/domain/whatsapp-sender.port';
import { MetaWhatsappSender } from '../../src/whatsapp/infrastructure/meta-whatsapp.sender';
import {
  createSandboxAllowlistSender,
  parseMetaSandboxConfig,
  type SandboxEnv,
} from './meta-sandbox-config';
import { MetaSandboxModule, SandboxSender } from './meta-sandbox.module';

// M2a2 test-only bootstrap: reuses the M1 MetaSandboxModule (real guard/
// controller/dispatcher, fake agent/sender/receipt/handoff), swaps in the M2a1
// parsed config, and fences outbound through the M2a1 allowlist. Real Meta is
// wired only in explicit `--outbound` mode; local mode is fake-sender only.
// This boundary never reads process.env itself and never prints secret values.

export type SandboxMode = 'local' | 'outbound';

/** Explicit CLI opt-in; env values alone can never enable outbound. */
export const SANDBOX_OUTBOUND_FLAG = '--outbound';
export const SANDBOX_BIND_HOST = '127.0.0.1';
export const SANDBOX_DEFAULT_PORT = 3000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PORT_PATTERN = /^\d{1,5}$/;
const CLI_FILE_PATTERN = /meta-sandbox-bootstrap\.[cm]?[jt]s$/;

export function resolveSandboxMode(argv: readonly string[]): SandboxMode {
  return argv.includes(SANDBOX_OUTBOUND_FLAG) ? 'outbound' : 'local';
}

/** Loopback-only bind; any other host is rejected (never 0.0.0.0). */
export function resolveBindHost(host: string = SANDBOX_BIND_HOST): string {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('Meta sandbox: only loopback binds are allowed');
  }
  return SANDBOX_BIND_HOST;
}

export function resolveBindPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SANDBOX_DEFAULT_PORT;
  const trimmed = raw.trim();
  const port = Number(trimmed);
  if (!PORT_PATTERN.test(trimmed) || port < 1 || port > 65535) {
    throw new Error('Meta sandbox: META_SANDBOX_PORT must be 1-65535');
  }
  return port;
}

export interface MetaSandboxAppOptions {
  readonly env: SandboxEnv;
  /** Defaults to `local`; `outbound` requires the explicit CLI flag. */
  readonly mode?: SandboxMode;
  /** Test seam: underlying transport behind the outbound allowlist fence. */
  readonly outboundTransport?: WhatsappSenderPort;
}

export interface MetaSandboxApp {
  readonly app: INestApplication<Server>;
  readonly mode: SandboxMode;
  readonly sender: WhatsappSenderPort;
  listen(options?: { readonly port?: number }): Promise<string>;
}

export async function createMetaSandboxApp(
  options: MetaSandboxAppOptions,
): Promise<MetaSandboxApp> {
  const mode = options.mode ?? 'local';
  // Parse first: malformed/missing config throws before any app or bind.
  const config = parseMetaSandboxConfig(options.env);
  const values: Record<string, unknown> = {
    'meta.verifyToken': config.verifyToken,
    'meta.appSecret': config.appSecret,
    'meta.accessToken': config.accessToken,
    'meta.phoneNumberId': config.phoneNumberId,
    'meta.graphApiBaseUrl': config.graphApiBaseUrl,
  };
  const configService = {
    get: (key: string): unknown => values[key],
    getOrThrow: (key: string): unknown => {
      if (!(key in values)) {
        throw new Error(`Meta sandbox: unconfigured config key "${key}"`);
      }
      return values[key];
    },
  };
  const needsRealSender =
    mode === 'outbound' && options.outboundTransport === undefined;

  const builder = Test.createTestingModule({
    imports: needsRealSender
      ? [MetaSandboxModule, HttpModule]
      : [MetaSandboxModule],
  });
  builder.overrideProvider(ConfigService).useValue(configService);

  if (mode === 'local') {
    builder.overrideProvider(WHATSAPP_SENDER).useValue(new SandboxSender());
  } else if (options.outboundTransport !== undefined) {
    builder
      .overrideProvider(WHATSAPP_SENDER)
      .useValue(
        createSandboxAllowlistSender(options.outboundTransport, config),
      );
  } else {
    builder.overrideProvider(WHATSAPP_SENDER).useFactory({
      factory: (http: HttpService) =>
        createSandboxAllowlistSender(
          new MetaWhatsappSender(
            http,
            configService as unknown as ConfigService,
          ),
          config,
        ),
      inject: [HttpService],
    });
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>({
    rawBody: true,
    logger: false,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const host = resolveBindHost();
  const server = app.getHttpServer();

  return {
    app,
    mode,
    sender: app.get<WhatsappSenderPort>(WHATSAPP_SENDER),
    listen: async (listenOptions) => {
      const port =
        listenOptions?.port ?? resolveBindPort(options.env.META_SANDBOX_PORT);
      await app.listen(port, host);
      const address = server.address();
      const boundPort =
        typeof address === 'object' && address !== null ? address.port : port;
      return `http://${host}:${boundPort}`;
    },
  };
}

/** CLI entry: parse -> build -> bind, then print only non-secret info. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: SandboxEnv = process.env,
): Promise<MetaSandboxApp> {
  const sandbox = await createMetaSandboxApp({
    env,
    mode: resolveSandboxMode(argv),
  });
  const url = await sandbox.listen();
  console.log(`[meta-sandbox] mode=${sandbox.mode} url=${url} (loopback only)`);
  console.log(
    sandbox.mode === 'outbound'
      ? '[meta-sandbox] outbound enabled: sends are fenced to the approved recipient'
      : '[meta-sandbox] local mode: fake sender only, no Meta calls',
  );
  return sandbox;
}

const invokedPath = process.argv[1] ?? '';
if (invokedPath !== '' && CLI_FILE_PATTERN.test(invokedPath)) {
  void main().catch((error: unknown) => {
    console.error(
      `[meta-sandbox] failed to start: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    process.exitCode = 1;
  });
}
