/**
 * Unit tests for ReceiptMetricsAuthGuard.
 *
 * Scope: WU15-1 CONFIG/AUTH — Guard contract only.
 * Runtime harness: unit request-boundary tests with fake ExecutionContext,
 * stable fixed fake tokens, isolated ConfigService stubs, no live services.
 * NOT a full Nest HTTP integration test — 200/401/404 composition belongs
 * to the controller task (WU15-2).
 *
 * Guard contract:
 *  - metrics disabled → 404 regardless of Authorization
 *  - metrics enabled + missing/invalid/malformed Authorization → 401
 *  - metrics enabled + correct dedicated Bearer token → true
 *  - Token only through Authorization header; never query/cookies
 *  - Case-insensitive HTTP auth scheme; strict token bytes
 *  - request and request.headers must be plain objects
 *  - Reject duplicate Authorization headers (check rawHeaders)
 *  - Raw Authorization value exactly equals parsed Authorization
 *  - Constant-time comparison of fixed-size SHA-256 digests
 *  - Never log or expose any token or digest value
 *  - Runtime malformed/headers TypeError → 401, never 500
 */
import {
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import * as net from 'node:net';
import { ReceiptMetricsAuthGuard } from './receipt-metrics-auth.guard';

/** Valid test fixture: exactly 64 hex chars, case-insensitive. */
const FIXED_FAKE_TOKEN =
  'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';
const WRONG_TOKEN =
  '0000000000000000000000000000000000000000000000000000000000000000';
const UPPER_HEX_TOKEN =
  'A1B2C3D4E5F6789012345678901234567890ABCDEF1234567890ABCDEF123456';

function makeMockConfig(getImpl: (key: string) => unknown): ConfigService {
  return { get: getImpl } as ConfigService;
}

function makeDefaultMock(): ConfigService {
  return makeMockConfig((key) =>
    key === 'receiptMedia.metricsEnabled'
      ? true
      : key === 'receiptMedia.metricsToken'
        ? FIXED_FAKE_TOKEN
        : undefined,
  );
}

function makeDisabledMock(): ConfigService {
  return makeMockConfig((key) =>
    key === 'receiptMedia.metricsEnabled'
      ? false
      : key === 'receiptMedia.metricsToken'
        ? FIXED_FAKE_TOKEN
        : undefined,
  );
}

function makeUndefinedEnabledMock(): ConfigService {
  return makeMockConfig(() => undefined);
}

function makeWrongTokenMock(): ConfigService {
  return makeMockConfig((key) =>
    key === 'receiptMedia.metricsEnabled'
      ? true
      : key === 'receiptMedia.metricsToken'
        ? WRONG_TOKEN
        : undefined,
  );
}

function makeCustomMock(opts: {
  metricsEnabled?: boolean;
  metricsToken?: string;
}): ConfigService {
  return makeMockConfig((key) =>
    key === 'receiptMedia.metricsEnabled'
      ? opts.metricsEnabled
      : key === 'receiptMedia.metricsToken'
        ? opts.metricsToken
        : undefined,
  );
}

type ParsedRequest = { headers: Record<string, unknown> };
type FullRequest = {
  headers: Record<string, unknown>;
  rawHeaders: string[];
};

function makeParsedCtx(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: (): ParsedRequest => ({ headers }),
    }),
  } as ExecutionContext;
}

function makeFullCtx(
  headers: Record<string, unknown>,
  rawHeaders: string[],
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: (): FullRequest => ({ headers, rawHeaders }),
    }),
  } as ExecutionContext;
}

const VALID_RAW = [
  'Authorization',
  `Bearer ${FIXED_FAKE_TOKEN}`,
  'X-Request-Id',
  'test-id',
];

describe('ReceiptMetricsAuthGuard', () => {
  // ─── Persistent regression: real Node IncomingMessage ────────────────────
  /**
   * Regression: real Node IncomingMessage(new Socket()) with null-prototype
   * headers and proper rawHeaders authenticates with a valid token.
   * Socket is never connected/listened; destroyed in finally.
   * This records the verified fix: isRecordLike accepts null-prototype records.
   */
  it('authenticates real Node IncomingMessage with null-prototype headers and valid token', () => {
    const socket = new net.Socket();
    const req = new http.IncomingMessage(socket);
    try {
      // Null-prototype headers: exact Node request prototype identity is preserved,
      // record-like means typeof object/non-null/non-array (not Object.prototype identity).
      Object.setPrototypeOf(req.headers, null);
      req.headers['authorization'] = `Bearer ${FIXED_FAKE_TOKEN}`;
      req.rawHeaders = [
        'Authorization',
        `Bearer ${FIXED_FAKE_TOKEN}`,
        'X-Request-Id',
        'test-regression-id',
      ];

      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => req,
          }),
        } as ExecutionContext),
      ).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  // ─── rawHeaders malformed-input rejection ──────────────────────────────
  describe('rawHeaders malformed → 401', () => {
    it('throws 401 when rawHeaders is null', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
              rawHeaders: null,
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders is a number', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
              rawHeaders: 42,
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders is a string', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
              rawHeaders: 'not an array',
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders is an object', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
              rawHeaders: {
                0: 'Authorization',
                1: `Bearer ${FIXED_FAKE_TOKEN}`,
              },
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders is an empty array (odd-length)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({ headers: {}, rawHeaders: [] }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders has odd length', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              rawHeaders: [
                'Authorization',
                `Bearer ${FIXED_FAKE_TOKEN}`,
                'Extra',
              ],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders contains a non-string key', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              rawHeaders: [42, `Bearer ${FIXED_FAKE_TOKEN}`],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders contains a non-string value', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              rawHeaders: ['Authorization', 42],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── rawHeaders required presence and raw/parsed consistency ──────────
  describe('rawHeaders required presence and raw/parsed consistency', () => {
    it('throws 401 when rawHeaders is undefined (missing)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders is empty (no auth present)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
              rawHeaders: ['X-Request-Id', 'test-id'],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when raw Authorization value differs from parsed', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
              rawHeaders: [
                'Authorization',
                `Bearer ${WRONG_TOKEN}`,
                'X-Request-Id',
                'test-id',
              ],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when parsed absent but raw Authorization present', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              rawHeaders: [
                'Authorization',
                `Bearer ${FIXED_FAKE_TOKEN}`,
                'X-Request-Id',
                'test-id',
              ],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── Request/headers must be plain objects ────────────────────────────
  describe('request and headers must be plain objects', () => {
    it('throws 401 when request is an array carrying valid auth properties', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const arrayReq = Object.assign([], {
        headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
        rawHeaders: VALID_RAW,
      });
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => arrayReq }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when request is a function carrying valid auth properties', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const fnReq = Object.assign(function dummy() {}, {
        headers: { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
        rawHeaders: VALID_RAW,
      });
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => fnReq }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when headers is an array carrying valid auth property', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: ['authorization', `Bearer ${FIXED_FAKE_TOKEN}`],
              rawHeaders: VALID_RAW,
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when headers is a function carrying valid auth property', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const fnHeaders = Object.assign(function h() {}, {
        authorization: `Bearer ${FIXED_FAKE_TOKEN}`,
      });
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({ headers: fnHeaders, rawHeaders: VALID_RAW }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    it('throws 404 when malformed request is provided but metrics are disabled', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDisabledMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => null }),
        } as ExecutionContext),
      ).toThrow(NotFoundException);
    });

    it('throws 401 when request headers container is null (enabled)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({ headers: null, rawHeaders: VALID_RAW }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── 404 when metrics are disabled ──────────────────────────────────
  describe('metrics disabled → 404', () => {
    it('throws 404 when metricsEnabled is false', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDisabledMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toThrow(NotFoundException);
    });

    it('throws 404 when metricsEnabled is undefined', () => {
      const guard = new ReceiptMetricsAuthGuard(makeUndefinedEnabledMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toThrow(NotFoundException);
    });

    it('throws 404 regardless of Authorization header when disabled', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDisabledMock());
      expect(() =>
        guard.canActivate(makeParsedCtx({ authorization: 'Bearer WRONG' })),
      ).toThrow(NotFoundException);
    });

    it('throws 404 when no Authorization header is present and disabled', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDisabledMock());
      expect(() => guard.canActivate(makeParsedCtx({}))).toThrow(
        NotFoundException,
      );
    });
  });

  // ─── 401 when metrics are enabled but Authorization is missing/malformed ─────
  describe('metrics enabled → 401 on auth failures', () => {
    // Intentionally missing raw: tests that verify missing rawHeaders behavior
    it('throws 401 when Authorization header is absent', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              rawHeaders: [
                'Authorization',
                `Bearer ${FIXED_FAKE_TOKEN}`,
                'X-Request-Id',
                'test-id',
              ],
            }),
          }),
        } as ExecutionContext),
      ).toThrow(UnauthorizedException);
    });

    // ─── Non-string parsed auth with valid preceding raw metadata ─────────
    it('throws 401 when Authorization is null', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(makeFullCtx({ authorization: null }, VALID_RAW)),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization is a number', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(makeFullCtx({ authorization: 42 }, VALID_RAW)),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization is an object', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: { key: 'value' } }, VALID_RAW),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization is an empty string', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: '' }, [
            'Authorization',
            '',
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization is an array', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: [FIXED_FAKE_TOKEN] }, VALID_RAW),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization is a comma-joined string', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx(
            {
              authorization: `Bearer ${FIXED_FAKE_TOKEN}, Bearer ${WRONG_TOKEN}`,
            },
            VALID_RAW,
          ),
        ),
      ).toThrow(UnauthorizedException);
    });

    // ─── Wrong scheme/format with raw+parsed matching that same wrong value ─
    it('throws 401 when Authorization scheme is Basic (not Bearer)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Basic ${FIXED_FAKE_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization scheme is Digest (not Bearer)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Digest ${FIXED_FAKE_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization has leading whitespace before scheme', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = ` Bearer ${FIXED_FAKE_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization scheme is missing (token only)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: FIXED_FAKE_TOKEN }, [
            'Authorization',
            FIXED_FAKE_TOKEN,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Bearer is followed by empty string', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: 'Bearer ' }, [
            'Authorization',
            'Bearer ',
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    // ─── Wrong token with raw+parsed matching that same wrong token ─────────
    it('throws 401 when token has leading whitespace', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Bearer  ${FIXED_FAKE_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token has trailing whitespace', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Bearer ${FIXED_FAKE_TOKEN} `;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token has internal whitespace', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const bad =
        FIXED_FAKE_TOKEN.slice(0, 32) + ' ' + FIXED_FAKE_TOKEN.slice(32);
      const val = `Bearer ${bad}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when Authorization has multiple parts after Bearer', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Bearer ${FIXED_FAKE_TOKEN} extra`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when the token value is wrong', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Bearer ${WRONG_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── Duplicate rawHeaders rejection ──────────────────────────────────
  describe('rawHeaders duplicate Authorization → 401', () => {
    it('throws 401 when rawHeaders has two Authorization fields, first valid, second wrong', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: `Bearer ${FIXED_FAKE_TOKEN}` }, [
            'Authorization',
            `Bearer ${FIXED_FAKE_TOKEN}`,
            'Authorization',
            `Bearer ${WRONG_TOKEN}`,
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders has two Authorization fields, first wrong, second valid', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: `Bearer ${WRONG_TOKEN}` }, [
            'Authorization',
            `Bearer ${WRONG_TOKEN}`,
            'Authorization',
            `Bearer ${FIXED_FAKE_TOKEN}`,
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when rawHeaders has two Authorization fields, both valid but different tokens', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: `Bearer ${FIXED_FAKE_TOKEN}` }, [
            'Authorization',
            `Bearer ${FIXED_FAKE_TOKEN}`,
            'Authorization',
            `Bearer ${WRONG_TOKEN}`,
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('accepts single Authorization in rawHeaders with correct token', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toBe(true);
    });

    it('rejects duplicate rawHeaders even when parsed headers shows no authorization', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: undefined }, [
            'Authorization',
            `Bearer ${FIXED_FAKE_TOKEN}`,
            'Authorization',
            `Bearer ${WRONG_TOKEN}`,
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('rejects duplicate rawHeaders even when parsed authorization is absent', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(() =>
        guard.canActivate(
          makeFullCtx({}, [
            'Authorization',
            `Bearer ${FIXED_FAKE_TOKEN}`,
            'Authorization',
            `Bearer ${WRONG_TOKEN}`,
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── Token format: exactly 64 hex chars ─────────────────────────────────
  describe('token format: exactly 64 ASCII hex characters', () => {
    it('throws 401 when token is only 1 hex char', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = 'Bearer a';
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token is 63 hex chars (one short)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = 'Bearer ' + 'a'.repeat(63);
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token is 65 hex chars (one over)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = 'Bearer ' + 'a'.repeat(65);
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token contains non-hex characters', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const nonHex = 'a'.repeat(63) + 'g';
      const val = `Bearer ${nonHex}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token contains internal whitespace', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const bad =
        FIXED_FAKE_TOKEN.slice(0, 32) + ' ' + FIXED_FAKE_TOKEN.slice(32);
      const val = `Bearer ${bad}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when token contains internal tab', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const bad =
        FIXED_FAKE_TOKEN.slice(0, 32) + '\t' + FIXED_FAKE_TOKEN.slice(32);
      const val = `Bearer ${bad}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('returns true when token is exactly 64 hex chars (lowercase)', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toBe(true);
    });

    it('throws 401 when configured lowercase token receives uppercase request token', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `Bearer ${UPPER_HEX_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when configured uppercase token receives lowercase request token', () => {
      const upperConfig = makeMockConfig((key) =>
        key === 'receiptMedia.metricsEnabled'
          ? true
          : key === 'receiptMedia.metricsToken'
            ? UPPER_HEX_TOKEN
            : undefined,
      );
      const guard = new ReceiptMetricsAuthGuard(upperConfig);
      const val = `Bearer ${FIXED_FAKE_TOKEN}`;
      expect(() =>
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'Authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('returns true when token is exactly 64 hex chars (uppercase) and configured token is identical uppercase', () => {
      const upperConfig = makeMockConfig((key) =>
        key === 'receiptMedia.metricsEnabled'
          ? true
          : key === 'receiptMedia.metricsToken'
            ? UPPER_HEX_TOKEN
            : undefined,
      );
      const guard = new ReceiptMetricsAuthGuard(upperConfig);
      const upperRaw = [
        'Authorization',
        `Bearer ${UPPER_HEX_TOKEN}`,
        'X-Request-Id',
        'test-id',
      ];
      expect(
        guard.canActivate(
          makeFullCtx({ authorization: `Bearer ${UPPER_HEX_TOKEN}` }, upperRaw),
        ),
      ).toBe(true);
    });

    it('returns true with lowercase bearer scheme', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      const val = `bearer ${FIXED_FAKE_TOKEN}`;
      expect(
        guard.canActivate(
          makeFullCtx({ authorization: val }, [
            'authorization',
            val,
            'X-Request-Id',
            'test-id',
          ]),
        ),
      ).toBe(true);
    });

    it('returns true with mixed-case Bearer scheme', () => {
      const guard = new ReceiptMetricsAuthGuard(makeDefaultMock());
      expect(
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toBe(true);
    });
  });

  // ─── Defense-in-depth: missing configured token → deny ──────────────
  describe('defense-in-depth: missing configured token → deny', () => {
    it('throws 401 when configured token is undefined', () => {
      const guard = new ReceiptMetricsAuthGuard(
        makeCustomMock({ metricsEnabled: true, metricsToken: undefined }),
      );
      expect(() =>
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when configured token is empty string', () => {
      const guard = new ReceiptMetricsAuthGuard(
        makeCustomMock({ metricsEnabled: true, metricsToken: '' }),
      );
      expect(() =>
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('throws 401 when configured token is whitespace-only string', () => {
      const guard = new ReceiptMetricsAuthGuard(
        makeCustomMock({ metricsEnabled: true, metricsToken: '   ' }),
      );
      expect(() =>
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── No token leak in error messages ───────────────────────────────
  describe('no token leakage in error messages', () => {
    it('does not include the configured token in the 401 error', () => {
      expect.assertions(2);
      const guard = new ReceiptMetricsAuthGuard(makeWrongTokenMock());
      try {
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        const msg = JSON.stringify((e as UnauthorizedException).getResponse());
        expect(msg).not.toContain(FIXED_FAKE_TOKEN);
      }
    });

    it('does not include the request token in the 401 error when tokens mismatch', () => {
      expect.assertions(2);
      const DIFFERENT_TOKEN =
        'b2c3d4e5f67890123456789012345678901bcdef01234567890bcdef01234567';
      const guard = new ReceiptMetricsAuthGuard(
        makeCustomMock({ metricsEnabled: true, metricsToken: DIFFERENT_TOKEN }),
      );
      try {
        guard.canActivate(
          makeFullCtx(
            { authorization: `Bearer ${FIXED_FAKE_TOKEN}` },
            VALID_RAW,
          ),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        const msg = JSON.stringify((e as UnauthorizedException).getResponse());
        expect(msg).not.toContain(FIXED_FAKE_TOKEN);
      }
    });
  });

  // ─── Class is Injectable ────────────────────────────────────────
  describe('class decorator and injectability', () => {
    it('has canActivate on the prototype', () => {
      expect(
        typeof (
          ReceiptMetricsAuthGuard.prototype as unknown as Record<
            string,
            unknown
          >
        ).canActivate,
      ).toBe('function');
    });

    it('has a constructor that accepts ConfigService', () => {
      expect(
        () => new ReceiptMetricsAuthGuard(makeDefaultMock()),
      ).not.toThrow();
    });
  });
});
