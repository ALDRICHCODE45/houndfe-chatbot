jest.mock('crypto', () => {
  const actualCrypto = jest.requireActual<typeof import('crypto')>('crypto');

  return {
    ...actualCrypto,
    timingSafeEqual: jest.fn(actualCrypto.timingSafeEqual),
  };
});

import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { readVerifiedWebhookSnapshot, SignatureGuard } from './signature.guard';

type MockRequest = {
  rawBody?: Buffer;
  headers: Record<string, string | undefined>;
  body?: { text: string };
};

describe('SignatureGuard', () => {
  const appSecret = 'meta-app-secret-for-tests';
  const payload = Buffer.from(
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '5215550001111', text: { body: 'hola' } }],
              },
            },
          ],
        },
      ],
    }),
    'utf8',
  );

  let guard: SignatureGuard;
  let configService: ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();

    // In-memory `ConfigService`: `meta.appSecret` resolves through the internal
    // config via dot-notation, matching the production runtime contract instead
    // of a partial mock of the overloaded `getOrThrow`.
    configService = new ConfigService({ meta: { appSecret } });

    guard = new SignatureGuard(configService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function signedRequest(rawBody = Buffer.from(payload)): MockRequest {
    return { rawBody, headers: { 'x-hub-signature-256': sign(rawBody) } };
  }

  function sign(body: Buffer) {
    return `sha256=${crypto.createHmac('sha256', appSecret).update(body).digest('hex')}`;
  }

  function executionContextFor(request: MockRequest): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;
  }

  describe('verified raw snapshot', () => {
    beforeEach(() => {
      configService.set('humanDecisions.restockEnabled', true);
    });

    it('publishes frozen exact bytes with local post-verification UTC milliseconds', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-01T10:00:00.001Z'));
      const request = Object.assign(signedRequest(Buffer.from('¡Hola 🐶!')), {
        observedAt: '2000-01-01T00:00:00.000Z',
      });
      jest.mocked(crypto.timingSafeEqual).mockImplementationOnce(() => {
        jest.setSystemTime(new Date('2026-07-01T10:00:00.123Z'));
        return true;
      });

      expect(guard.canActivate(executionContextFor(request))).toBe(true);
      const snapshot = readVerifiedWebhookSnapshot(request);
      expect(snapshot).toEqual({
        rawBodyBase64: Buffer.from('¡Hola 🐶!').toString('base64'),
        observedAt: '2026-07-01T10:00:00.123Z',
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      jest.advanceTimersByTime(5000);
      expect(readVerifiedWebhookSnapshot(request)).toBe(snapshot);
      expect(snapshot?.observedAt).toBe('2026-07-01T10:00:00.123Z');
    });

    it('isolates bytes from later buffer, rawBody, parsed body and result mutations', () => {
      const request = signedRequest();
      request.body = { text: 'original' };
      guard.canActivate(executionContextFor(request));
      const snapshot = readVerifiedWebhookSnapshot(request);
      expect(snapshot).not.toBeNull();
      request.rawBody!.fill(0);
      request.rawBody = Buffer.from('replacement');
      request.body.text = 'changed';
      request.body = { text: 'replaced' };
      expect(() =>
        Object.assign(snapshot!, { rawBodyBase64: 'forged' }),
      ).toThrow(TypeError);
      expect(() => Object.assign(snapshot!, { observedAt: 'forged' })).toThrow(
        TypeError,
      );
      expect(readVerifiedWebhookSnapshot(request)).toBe(snapshot);
      expect(snapshot?.rawBodyBase64).toBe(payload.toString('base64'));
    });

    it('publishes the detached bytes used by HMAC, not a later request buffer', () => {
      const request = signedRequest();
      const original = request.rawBody!;
      const actualCompare =
        jest.requireActual<typeof import('crypto')>('crypto').timingSafeEqual;
      jest.mocked(crypto.timingSafeEqual).mockImplementationOnce((a, b) => {
        original.fill(0);
        request.rawBody = Buffer.from('replacement');
        return actualCompare(a, b);
      });
      expect(guard.canActivate(executionContextFor(request))).toBe(true);
      expect(readVerifiedWebhookSnapshot(request)?.rawBodyBase64).toBe(
        payload.toString('base64'),
      );
    });

    it('preserves authenticated invalid UTF-8 as raw bytes without JSON admission', () => {
      const bytes = Buffer.from([0xff, 0xc3, 0x28, 0x00]);
      const request = signedRequest(bytes);
      expect(guard.canActivate(executionContextFor(request))).toBe(true);
      expect(readVerifiedWebhookSnapshot(request)?.rawBodyBase64).toBe(
        bytes.toString('base64'),
      );
    });

    it('does not transfer proof to an independent request or accept spoofed properties', () => {
      const request = signedRequest();
      guard.canActivate(executionContextFor(request));
      const snapshot = readVerifiedWebhookSnapshot(request);
      expect(snapshot).not.toBeNull();
      const other = Object.assign(signedRequest(), {
        verifiedWebhookSnapshot: snapshot,
        verified: true,
        body: { text: 'forged', verifiedWebhookSnapshot: snapshot },
      });
      expect(readVerifiedWebhookSnapshot(other)).toBeNull();
      expect(readVerifiedWebhookSnapshot(other.body)).toBeNull();
    });

    it.each(['corrupt MAC', 'missing MAC', 'missing raw body'])(
      'leaves no proof on %s, including after earlier success',
      (failure) => {
        for (const previouslyVerified of [false, true]) {
          const request = signedRequest();
          if (previouslyVerified) {
            guard.canActivate(executionContextFor(request));
            expect(readVerifiedWebhookSnapshot(request)).not.toBeNull();
          }
          if (failure === 'missing raw body') delete request.rawBody;
          else
            request.headers['x-hub-signature-256'] =
              failure === 'missing MAC'
                ? undefined
                : `sha256=${'0'.repeat(64)}`;
          expect(() => guard.canActivate(executionContextFor(request))).toThrow(
            UnauthorizedException,
          );
          expect(readVerifiedWebhookSnapshot(request)).toBeNull();
        }
      },
    );

    it.each([false, undefined, 'true'])(
      'publishes no snapshot for flag %p and clears earlier proof',
      (flag) => {
        const request = signedRequest();
        guard.canActivate(executionContextFor(request));
        expect(readVerifiedWebhookSnapshot(request)).not.toBeNull();
        configService.set('humanDecisions.restockEnabled', flag);
        expect(guard.canActivate(executionContextFor(request))).toBe(true);
        expect(readVerifiedWebhookSnapshot(request)).toBeNull();
        const fresh = signedRequest();
        expect(guard.canActivate(executionContextFor(fresh))).toBe(true);
        expect(readVerifiedWebhookSnapshot(fresh)).toBeNull();
      },
    );
  });

  it('accepts a valid Meta signature computed from the exact raw body bytes', () => {
    const request: MockRequest = {
      rawBody: payload,
      headers: {
        'x-hub-signature-256': sign(payload),
      },
    };

    expect(guard.canActivate(executionContextFor(request))).toBe(true);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing signature header with 401', () => {
    const request: MockRequest = {
      rawBody: payload,
      headers: {},
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a tampered body when the signature was computed for different bytes', () => {
    const request: MockRequest = {
      rawBody: Buffer.from(
        payload.toString('utf8').replace('hola', 'adios'),
        'utf8',
      ),
      headers: {
        'x-hub-signature-256': sign(payload),
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an equal-length but invalid MAC with 401', () => {
    const request: MockRequest = {
      rawBody: payload,
      headers: {
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a different-length MAC before timingSafeEqual and does not throw from buffer mismatch', () => {
    const request: MockRequest = {
      rawBody: payload,
      headers: {
        'x-hub-signature-256': 'sha256=abcd',
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(
      UnauthorizedException,
    );
    expect(crypto.timingSafeEqual).not.toHaveBeenCalled();
  });

  it('fails closed when rawBody is absent even if the signature header looks valid', () => {
    // The signature header is a correctly-formatted sha256=... value so that the
    // header-parsing path does not short-circuit; the guard must still deny the
    // request because there is no raw body bytes to HMAC against. This is the
    // "fail closed" requirement from the webhook spec.
    const request: MockRequest = {
      headers: {
        'x-hub-signature-256': sign(payload),
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(
      UnauthorizedException,
    );
    // rawBody absence must be caught BEFORE constant-time MAC comparison to avoid
    // any timing oracle on body availability.
    expect(crypto.timingSafeEqual).not.toHaveBeenCalled();
  });
});
