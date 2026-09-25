import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { AgentRunner } from '../../src/llm-agent/application/agent-runner.service';
import {
  generateTextImpl,
  type GenerateTextFn,
} from '../../src/llm-agent/infrastructure/generate-text.provider';
import {
  WHATSAPP_SENDER,
  type WhatsappSenderPort,
} from '../../src/whatsapp/domain/whatsapp-sender.port';
import {
  MetaWhatsappSender,
  normalizeSandboxRecipient,
} from '../../src/whatsapp/infrastructure/meta-whatsapp.sender';
import {
  createSandboxAllowlistSender,
  parseMetaSandboxConfig,
  type SandboxEnv,
} from './meta-sandbox-config';
import { MetaSandboxModule, SandboxSender } from './meta-sandbox.module';
import {
  NO_TOOL_SANDBOX_FALLBACK_REPLY,
  createNoToolSandboxAgentRunner,
  parseNoToolLlmSandboxConfig,
  type NoToolSandboxAgentRunner,
} from './no-tool-llm-sandbox';

// M2a2/M2c test-only bootstrap: reuses the M1 MetaSandboxModule (real guard/
// controller/dispatcher, fake agent/sender/receipt/handoff), swaps in the M2a1
// parsed config, and fences outbound through the M2a1 allowlist. Real Meta is
// wired only in explicit `--outbound` mode; local mode is fake-sender only.
// The bounded no-tool LLM runner (M2b) is wired only behind explicit `--llm`
// with its own parsed config and a sender fence. This boundary never reads
// process.env itself and never prints secret values.

export type SandboxMode = 'local' | 'outbound';
export type SandboxLlmMode = 'fake' | 'llm';

/** Explicit CLI opt-in; env values alone can never enable outbound. */
export const SANDBOX_OUTBOUND_FLAG = '--outbound';
/** Explicit CLI opt-in; env values alone can never enable the real LLM seam. */
export const SANDBOX_LLM_FLAG = '--llm';
export const SANDBOX_BIND_HOST = '127.0.0.1';
export const SANDBOX_DEFAULT_PORT = 3000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PORT_PATTERN = /^\d{1,5}$/;
const CLI_FILE_PATTERN = /meta-sandbox-bootstrap\.[cm]?[jt]s$/;

export function resolveSandboxMode(argv: readonly string[]): SandboxMode {
  return argv.includes(SANDBOX_OUTBOUND_FLAG) ? 'outbound' : 'local';
}

/** Explicit CLI opt-in; the M1 fake runner stays the default. */
export function resolveLlmMode(argv: readonly string[]): SandboxLlmMode {
  return argv.includes(SANDBOX_LLM_FLAG) ? 'llm' : 'fake';
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
  /** Defaults to `fake`; `llm` requires the explicit `--llm` opt-in. */
  readonly llmMode?: SandboxLlmMode;
  /** Test seam: underlying transport behind the outbound allowlist fence. */
  readonly outboundTransport?: WhatsappSenderPort;
  /**
   * Test seam: fake AI SDK `generateText`. The real SDK function is used only
   * when `llmMode === 'llm'` AND this seam is absent.
   */
  readonly generateText?: GenerateTextFn;
}

export interface MetaSandboxApp {
  readonly app: INestApplication<Server>;
  readonly mode: SandboxMode;
  readonly llmMode: SandboxLlmMode;
  readonly sender: WhatsappSenderPort;
  listen(options?: { readonly port?: number }): Promise<string>;
}

/**
 * Sender fence around the bounded no-tool runner: an inbound whose `senderId`
 * does not normalize to the single approved Meta recipient is refused with the
 * safe fallback BEFORE the provider seam, so a mismatched webhook can never
 * burn the shared call budget. The approved recipient comes from the parsed
 * M2a1 config, never from a caller-supplied value.
 */
export function createApprovedSenderFencedRunner(deps: {
  readonly runner: NoToolSandboxAgentRunner;
  readonly approvedRecipient: string;
}): NoToolSandboxAgentRunner {
  const { runner, approvedRecipient } = deps;
  return {
    handle: (input: { readonly senderId: string; readonly text: string }) => {
      const senderId =
        typeof input?.senderId === 'string' ? input.senderId : '';
      if (normalizeSandboxRecipient(senderId) !== approvedRecipient) {
        return Promise.resolve({ reply: NO_TOOL_SANDBOX_FALLBACK_REPLY });
      }
      return runner.handle(input);
    },
  };
}

export async function createMetaSandboxApp(
  options: MetaSandboxAppOptions,
): Promise<MetaSandboxApp> {
  const mode = options.mode ?? 'local';
  const llmMode = options.llmMode ?? 'fake';
  // Parse first: malformed/missing config throws before any app or bind.
  const config = parseMetaSandboxConfig(options.env);
  // LLM config also fails closed here, still before compile/bind. Parsing the
  // explicit `options.env` keeps the adapter off the unsafe public config.
  const llmConfig =
    llmMode === 'llm' ? parseNoToolLlmSandboxConfig(options.env) : null;
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
  const builder = Test.createTestingModule({
    imports: [MetaSandboxModule],
  });
  builder.overrideProvider(ConfigService).useValue(configService);

  // One bounded runner per app: its call cap is shared across every webhook
  // message this process handles. Meta sender modes stay independent below.
  if (llmConfig !== null) {
    const generateText = options.generateText ?? generateTextImpl;
    builder.overrideProvider(AgentRunner).useValue(
      createApprovedSenderFencedRunner({
        runner: createNoToolSandboxAgentRunner({
          config: llmConfig,
          generateText,
        }),
        approvedRecipient: config.approvedRecipient,
      }),
    );
  }

  if (mode === 'local') {
    builder.overrideProvider(WHATSAPP_SENDER).useValue(new SandboxSender());
  } else if (options.outboundTransport !== undefined) {
    builder
      .overrideProvider(WHATSAPP_SENDER)
      .useValue(
        createSandboxAllowlistSender(options.outboundTransport, config),
      );
  } else {
    // Build the transport directly instead of injecting HttpService: the
    // override provider lives in MetaSandboxModule, so a sibling root import
    // of HttpModule cannot satisfy `inject: [HttpService]`. `new HttpService()`
    // defaults to the shared axios instance and stays fenced by the allowlist.
    builder
      .overrideProvider(WHATSAPP_SENDER)
      .useValue(
        createSandboxAllowlistSender(
          new MetaWhatsappSender(
            new HttpService(),
            configService as unknown as ConfigService,
          ),
          config,
        ),
      );
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
    llmMode,
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
    llmMode: resolveLlmMode(argv),
  });
  const url = await sandbox.listen();
  console.log(
    `[meta-sandbox] mode=${sandbox.mode} llm=${sandbox.llmMode} url=${url} (loopback only)`,
  );
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
