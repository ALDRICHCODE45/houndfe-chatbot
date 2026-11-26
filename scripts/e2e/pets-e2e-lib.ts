/** Pure helpers of `pets-e2e.ts` (multi-pet T7 live rehearsal): the base URL
 * allow-list, the test-phone and test-customer guards, secret redaction and
 * the numbered PASS / FAIL / SKIP step runner. No network, no env reads, so
 * `pets-e2e-lib.spec.ts` can pin them. */
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';

/** Explicit dev hosts (`host:port`). Anything else is refused: the script
 *  writes and deletes data, so it must never reach production. */
export const DEV_HOST_ALLOW_LIST: readonly string[] = [
  'localhost:3003',
  '127.0.0.1:3003',
];

/** The normalized origin (`http://localhost:3003`) when the URL is plain
 *  http on an allow-listed host:port with no credentials, path, query or
 *  hash; otherwise `null`. */
export function checkBaseUrl(
  raw: string,
  allowList: readonly string[] = DEV_HOST_ALLOW_LIST,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  if (!allowList.includes(url.host)) return null;
  return `${url.protocol}//${url.host}`;
}

/** Clearly fake Mexican test numbers only: 10 digits starting with `555`. */
export function checkTestPhone(raw: string): string | null {
  const phone = raw.trim();
  return /^555\d{7}$/.test(phone) ? phone : null;
}

/** First name every customer this script creates or touches must carry. */
export const TEST_CUSTOMER_PREFIX = 'E2E ';

/** A customer found by the test phone is only touched when it is a test
 *  customer (its first name starts with `E2E `); anyone else is refused. */
export function isTestCustomerName(firstName: unknown): boolean {
  return (
    typeof firstName === 'string' && firstName.startsWith(TEST_CUSTOMER_PREFIX)
  );
}

export const REDACTED = '[REDACTED]';

/** Removes every given secret, any `svc_…` key and any `Bearer …` token
 *  from a log line. Empty secrets are ignored. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    out = out.split(secret).join(REDACTED);
  }
  return out
    .replace(/svc_[A-Za-z0-9._~+/=-]+/g, REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
}

/** Thrown by `StepRunner.fail`: the rehearsal stops, cleanup still runs. */
export class StepFailure extends Error {}

/** Status and stable error code of any failure; never messages, headers or
 *  bodies (they could carry personal values or the key). */
export function describeError(error: unknown): {
  http: number | null;
  code: string | null;
  error: string;
} {
  if (error instanceof ChatbotApiError)
    return {
      http: error.statusCode,
      code: error.errorCode,
      error: error.name,
    };
  return {
    http: null,
    code: null,
    error: error instanceof Error ? error.name : typeof error,
  };
}

export type StepOutcome = 'PASS' | 'FAIL' | 'SKIP';

export interface StepResult {
  step: string;
  outcome: StepOutcome;
  http: string | null;
  code: string | null;
}

/** Numbered PASS / FAIL / SKIP steps. Every line goes through `redact`. */
export class StepRunner {
  readonly results: StepResult[] = [];

  constructor(
    private readonly write: (line: string) => void,
    private readonly secrets: readonly string[] = [],
  ) {}

  line(step: string, outcome: string, fields: Record<string, unknown> = {}) {
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');
    this.write(
      redact(
        `[${step}] ${outcome}${rendered ? ` ${rendered}` : ''}\n`,
        this.secrets,
      ),
    );
  }

  pass(
    step: string,
    http: number | string | null,
    fields: Record<string, unknown> = {},
  ): void {
    this.results.push({
      step,
      outcome: 'PASS',
      http: http === null ? null : String(http),
      code: null,
    });
    this.line(step, 'PASS', { ...(http === null ? {} : { http }), ...fields });
  }

  /** An expected error answer (e.g. 409 PET_VERSION_CONFLICT) is a PASS. */
  passCode(
    step: string,
    http: number | null,
    code: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.results.push({
      step,
      outcome: 'PASS',
      http: http === null ? null : String(http),
      code,
    });
    this.line(step, 'PASS', {
      ...(http === null ? {} : { http }),
      code,
      ...fields,
    });
  }

  skip(step: string, reason: string): void {
    this.results.push({ step, outcome: 'SKIP', http: null, code: null });
    this.line(step, 'SKIP', { reason });
  }

  fail(
    step: string,
    reason: string,
    fields: Record<string, unknown> = {},
    http: number | null = null,
    code: string | null = null,
  ): never {
    this.results.push({
      step,
      outcome: 'FAIL',
      http: http === null ? null : String(http),
      code,
    });
    this.line(step, 'FAIL', {
      ...(http === null ? {} : { http }),
      ...(code === null ? {} : { code }),
      reason,
      ...fields,
    });
    throw new StepFailure(step);
  }

  /** Runs a client call; an unexpected throw becomes a FAIL with its status
   *  and code only. */
  async call<T>(step: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      const described = describeError(error);
      return this.fail(
        step,
        'client call failed',
        { error: described.error },
        described.http,
        described.code,
      );
    }
  }

  /** One `step:OUTCOME[:http][:code]` entry per step. */
  summaryEntries(): string[] {
    return this.results.map((result) =>
      [
        result.step,
        result.outcome,
        ...(result.http === null ? [] : [result.http]),
        ...(result.code === null ? [] : [result.code]),
      ].join(':'),
    );
  }

  counts(): Record<StepOutcome, number> {
    const counts: Record<StepOutcome, number> = { PASS: 0, FAIL: 0, SKIP: 0 };
    for (const result of this.results) counts[result.outcome] += 1;
    return counts;
  }
}

/** 0 only when at least one step passed, no step failed, the run was not
 *  aborted and everything created was cleaned up; otherwise 1. */
export function exitCodeFor(
  results: readonly StepResult[],
  aborted: boolean,
  notCleaned: readonly string[],
): 0 | 1 {
  const failed = results.some((result) => result.outcome === 'FAIL');
  const passed = results.some((result) => result.outcome === 'PASS');
  return !aborted && !failed && passed && notCleaned.length === 0 ? 0 : 1;
}
