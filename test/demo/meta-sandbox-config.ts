import {
  type OutboundText,
  type SendResult,
  type WhatsappSenderPort,
} from '../../src/whatsapp/domain/whatsapp-sender.port';
import { normalizeSandboxRecipient } from '../../src/whatsapp/infrastructure/meta-whatsapp.sender';

// M2a1: pure, test-only sandbox config parser + recipient fence for the Meta
// test-number demo. Never reads process.env and never echoes secret values.

/** Explicit environment input (a plain record, never the live process env). */
export type SandboxEnv = Readonly<Record<string, string | undefined>>;

export const META_GRAPH_API_ORIGIN = 'https://graph.facebook.com';
export const SANDBOX_GRAPH_API_VERSION_DEFAULT = 'v23.0';

const GRAPH_VERSION_PATTERN = /^v\d+\.\d+$/;
const GRAPH_BASE_URL_PATTERN = /^https:\/\/graph\.facebook\.com\/v\d+\.\d+$/;
const RECIPIENT_DIGITS_PATTERN = /^\d{8,15}$/;
const DIGITS_PATTERN = /^\d+$/;

export type SandboxConfigErrorCode =
  | 'missing_required_value'
  | 'malformed_value'
  | 'graph_origin_not_allowed';

/** Rejection carrying only the env field name and a code, never values. */
export class SandboxConfigError extends Error {
  constructor(
    readonly code: SandboxConfigErrorCode,
    readonly field: string,
  ) {
    super(`Meta sandbox config rejected "${field}" (${code})`);
    this.name = 'SandboxConfigError';
  }
}

export type SandboxOutboundErrorCode =
  | 'empty_outbound_text'
  | 'recipient_not_allowed';

export class SandboxOutboundError extends Error {
  constructor(readonly code: SandboxOutboundErrorCode) {
    super(
      code === 'empty_outbound_text'
        ? 'Sandbox sender refused empty outbound text'
        : 'Sandbox sender refused a recipient outside the approved allowlist',
    );
    this.name = 'SandboxOutboundError';
  }
}

export interface MetaSandboxConfig {
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly accessToken: string;
  readonly phoneNumberId: string;
  /** Canonical form of the single owner-approved test recipient. */
  readonly approvedRecipient: string;
  /** Canonical Graph base URL; the origin is always graph.facebook.com. */
  readonly graphApiBaseUrl: string;
}

function requireValue(env: SandboxEnv, key: string): string {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SandboxConfigError('missing_required_value', key);
  }
  return raw;
}

function resolveGraphApiBaseUrl(env: SandboxEnv): string {
  const explicit = env.META_GRAPH_API_BASE_URL;
  if (explicit !== undefined) {
    // Accept only the canonical origin; never echo untrusted SSRF input.
    if (
      typeof explicit !== 'string' ||
      !GRAPH_BASE_URL_PATTERN.test(explicit)
    ) {
      throw new SandboxConfigError(
        'graph_origin_not_allowed',
        'META_GRAPH_API_BASE_URL',
      );
    }
    return explicit;
  }
  const version =
    env.META_GRAPH_API_VERSION ?? SANDBOX_GRAPH_API_VERSION_DEFAULT;
  if (!GRAPH_VERSION_PATTERN.test(version)) {
    throw new SandboxConfigError('malformed_value', 'META_GRAPH_API_VERSION');
  }
  return `${META_GRAPH_API_ORIGIN}/${version}`;
}

/** Parses an explicit env record; missing/malformed values fail closed. */
export function parseMetaSandboxConfig(env: SandboxEnv): MetaSandboxConfig {
  const verifyToken = requireValue(env, 'META_VERIFY_TOKEN');
  const appSecret = requireValue(env, 'META_APP_SECRET');
  const accessToken = requireValue(env, 'META_ACCESS_TOKEN');
  const phoneNumberId = requireValue(env, 'META_PHONE_NUMBER_ID');
  if (!DIGITS_PATTERN.test(phoneNumberId)) {
    throw new SandboxConfigError('malformed_value', 'META_PHONE_NUMBER_ID');
  }
  const rawRecipient = requireValue(env, 'META_SANDBOX_RECIPIENT').trim();
  if (!RECIPIENT_DIGITS_PATTERN.test(rawRecipient)) {
    throw new SandboxConfigError('malformed_value', 'META_SANDBOX_RECIPIENT');
  }
  return {
    verifyToken,
    appSecret,
    accessToken,
    phoneNumberId,
    approvedRecipient: normalizeSandboxRecipient(rawRecipient),
    graphApiBaseUrl: resolveGraphApiBaseUrl(env),
  };
}

/** Redacted sender projection; the app secret/verify token are dropped. */
export function toMetaSenderConfig(config: MetaSandboxConfig): {
  meta: { accessToken: string; phoneNumberId: string; graphApiBaseUrl: string };
} {
  return {
    meta: {
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      graphApiBaseUrl: config.graphApiBaseUrl,
    },
  };
}

/**
 * Recipient fence around any WhatsappSenderPort: only the exact canonical
 * approved recipient passes, only with non-empty text, and env presence never
 * implies permission to send to arbitrary numbers.
 */
export class SandboxAllowlistSender implements WhatsappSenderPort {
  constructor(
    private readonly inner: WhatsappSenderPort,
    private readonly approvedRecipient: string,
  ) {}

  sendText(message: OutboundText): Promise<SendResult> {
    const text: unknown = (message as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return Promise.reject(new SandboxOutboundError('empty_outbound_text'));
    }
    const to: unknown = (message as { to?: unknown } | undefined)?.to;
    const normalized =
      typeof to === 'string' ? normalizeSandboxRecipient(to) : '';
    if (normalized !== this.approvedRecipient) {
      return Promise.reject(new SandboxOutboundError('recipient_not_allowed'));
    }
    return this.inner.sendText({ ...message, to: normalized });
  }
}

export function createSandboxAllowlistSender(
  inner: WhatsappSenderPort,
  config: MetaSandboxConfig,
): WhatsappSenderPort {
  return new SandboxAllowlistSender(inner, config.approvedRecipient);
}
