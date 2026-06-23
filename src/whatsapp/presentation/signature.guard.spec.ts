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
import { SignatureGuard } from './signature.guard';

type MockRequest = {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
};

describe('SignatureGuard', () => {
  const appSecret = 'meta-app-secret-for-tests';
  const payload = Buffer.from(
    JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: '5215550001111', text: { body: 'hola' } }] } }] }],
    }),
    'utf8',
  );

  let configService: jest.Mocked<Pick<ConfigService, 'getOrThrow'>>;
  let guard: SignatureGuard;

  beforeEach(() => {
    jest.clearAllMocks();

    configService = {
      getOrThrow: jest.fn(() => appSecret),
    };

    guard = new SignatureGuard(configService as ConfigService);
  });

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

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(UnauthorizedException);
  });

  it('rejects a tampered body when the signature was computed for different bytes', () => {
    const request: MockRequest = {
      rawBody: Buffer.from(payload.toString('utf8').replace('hola', 'adios'), 'utf8'),
      headers: {
        'x-hub-signature-256': sign(payload),
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(UnauthorizedException);
  });

  it('rejects an equal-length but invalid MAC with 401', () => {
    const request: MockRequest = {
      rawBody: payload,
      headers: {
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(UnauthorizedException);
  });

  it('rejects a different-length MAC before timingSafeEqual and does not throw from buffer mismatch', () => {
    const request: MockRequest = {
      rawBody: payload,
      headers: {
        'x-hub-signature-256': 'sha256=abcd',
      },
    };

    expect(() => guard.canActivate(executionContextFor(request))).toThrow(UnauthorizedException);
    expect(crypto.timingSafeEqual).not.toHaveBeenCalled();
  });
});
