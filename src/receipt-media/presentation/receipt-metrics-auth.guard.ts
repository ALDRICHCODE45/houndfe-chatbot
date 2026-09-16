/**
 * ReceiptMetricsAuthGuard — WU15-1 CONFIG/AUTH
 *
 * Protects the metrics endpoint with a dedicated Bearer token.
 *
 * Token contract: exactly 64 ASCII hex characters, generated from 32 random
 * bytes. Token comparison is CASE-SENSITIVE on the original UTF-8 bytes — the
 * configured token "AABB..." is NOT equal to the request token "aabb...".
 * SHA-256 digests of fixed-size buffers are compared with timingSafeEqual.
 *
 * Guard behavior (metrics enabled only):
 *   - rawHeaders must be present (non-null object with even-length string[]).
 *   - Exactly one raw Authorization field (case-insensitive name match).
 *   - Raw Authorization value must EXACTLY EQUAL the parsed single-string header.
 *   - Duplicate raw Authorization entries → HTTP 401.
 *   - Malformed rawHeaders (null/non-array/odd-length/non-string elements) → 401.
 *   - Non-string Authorization values (null/number/object) → HTTP 401.
 *   - Missing configured token at boot → enabled requests deny (401).
 *   - Constant-time SHA-256 digest comparison on fixed-size buffers.
 *   - Never log or expose any token value in error messages.
 *
 * Metrics disabled → HTTP 404 before any credential inspection.
 */
import * as crypto from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Canonical auth scheme. Comparison is case-insensitive per RFC 7235. */
const AUTH_SCHEME = 'Bearer';

/** Exactly 64 ASCII hex characters. */
const TOKEN_LENGTH = 64;

/** Pre-computed length of a SHA-256 digest in bytes. */
const DIGEST_BYTES = 32;

/** ASCII hex digit pattern for validation. */
const HEX_RE = /^[0-9a-f]{64}$/i;

/** Accept Node request instances and null-prototype header records while
 * rejecting null, arrays, and functions without restricting object prototypes. */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates the single raw Authorization value from rawHeaders.
 *
 * Node/Express rawHeaders is [name1, value1, name2, value2, ...].
 * Validates: rawHeaders is a non-null even-length string[].
 * Extracts the single raw Authorization value (case-insensitive name match),
 * checking there is EXACTLY ONE such field.
 * Returns the raw value or undefined if no Authorization field is present.
 * @throws TypeError if rawHeaders is malformed (caller converts to 401).
 */
function extractSingleRawAuth(rawHeaders: unknown): string | undefined {
  // rawHeaders is untrusted; validate shape before array access.
  if (rawHeaders === null || rawHeaders === undefined) {
    throw new TypeError('rawHeaders must be a string[]');
  }
  if (typeof rawHeaders !== 'object') {
    throw new TypeError('rawHeaders must be a string[]');
  }
  if (!Array.isArray(rawHeaders)) {
    throw new TypeError('rawHeaders must be a string[]');
  }
  if (rawHeaders.length % 2 !== 0) {
    throw new TypeError('rawHeaders must be a string[]');
  }
  for (const item of rawHeaders) {
    if (typeof item !== 'string') {
      throw new TypeError('rawHeaders must be a string[]');
    }
  }

  // Shape is valid: find Authorization entries.
  let rawAuthValue: string | undefined;
  let authCount = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] as string).toLowerCase() === 'authorization') {
      rawAuthValue = rawHeaders[i + 1] as string;
      authCount++;
      if (authCount > 1) {
        // More than one Authorization field.
        throw new TypeError('duplicate');
      }
    }
  }
  return rawAuthValue;
}

/**
 * Safely reads the Authorization header from parsed headers.
 * Returns the header value as a string, or undefined if absent.
 * Rejects non-string values (null, number, object, arrays).
 */
function readParsedAuth(headers: Record<string, unknown>): string | undefined {
  const raw = headers['authorization'];
  if (typeof raw !== 'string') return undefined;
  return raw;
}

@Injectable()
export class ReceiptMetricsAuthGuard implements CanActivate {
  /**
   * SHA-256 digest of the configured token, or undefined if the configured
   * value is not a non-empty 64-hex string. Guard denies all requests when
   * the digest is undefined.
   */
  private readonly configuredDigest: Buffer | undefined;

  constructor(private readonly configService: ConfigService) {
    const rawToken = this.configService.get<string>(
      'receiptMedia.metricsToken',
    );
    // Store digest only if the configured value is a valid token string.
    // Any other value (undefined, null, array, object, wrong-length, non-hex)
    // means enabled requests will deny — the guard never throws here.
    if (
      typeof rawToken === 'string' &&
      rawToken.length === TOKEN_LENGTH &&
      HEX_RE.test(rawToken)
    ) {
      this.configuredDigest = crypto
        .createHash('sha256')
        .update(rawToken, 'utf8')
        .digest();
    } else {
      this.configuredDigest = undefined;
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Record<string, unknown>>();

    // Gate 1: metrics must be enabled — before any auth inspection.
    // Disabled metrics: always 404 regardless of auth state.
    const metricsEnabled = this.configService.get<boolean>(
      'receiptMedia.metricsEnabled',
    );
    if (metricsEnabled !== true) {
      throw new NotFoundException('Metrics endpoint is not available');
    }

    // Validate container shapes without rejecting Node request prototypes.
    // Arrays (even with Object.assign) and functions must not authenticate.
    if (!isRecordLike(request)) {
      throw new UnauthorizedException('Invalid request');
    }
    const headersContainer = request['headers'];
    if (!isRecordLike(headersContainer)) {
      throw new UnauthorizedException('Invalid request');
    }

    // Gate 2: extract single raw Authorization value (throws TypeError on malformed rawHeaders)
    let rawAuthValue: string | undefined;
    try {
      rawAuthValue = extractSingleRawAuth(request.rawHeaders);
    } catch {
      throw new UnauthorizedException('Invalid Authorization header');
    }

    // Gate 3: read parsed Authorization header
    const parsedAuth = readParsedAuth(
      (request.headers ?? {}) as Record<string, unknown>,
    );
    if (parsedAuth === undefined) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    // Gate 4: raw and parsed must exactly match (no injection / value mismatch)
    if (rawAuthValue === undefined || rawAuthValue !== parsedAuth) {
      throw new UnauthorizedException('Invalid Authorization header');
    }

    // Gate 5: scheme check (case-insensitive per RFC 7235)
    const spaceIdx = parsedAuth.indexOf(' ');
    if (spaceIdx < 0) {
      throw new UnauthorizedException('Invalid Authorization header');
    }
    const scheme = parsedAuth.slice(0, spaceIdx);
    const tokenCandidate = parsedAuth.slice(spaceIdx + 1);
    if (scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) {
      throw new UnauthorizedException('Invalid Authorization header');
    }

    // Gate 6: token format — exactly 64 ASCII hex chars
    if (
      tokenCandidate.length !== TOKEN_LENGTH ||
      !HEX_RE.test(tokenCandidate)
    ) {
      throw new UnauthorizedException('Malformed Bearer token');
    }

    // Gate 7: enabled requests require a valid configured token
    if (this.configuredDigest === undefined) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Gate 8: constant-time digest comparison on original UTF-8 bytes.
    // Comparison is CASE-SENSITIVE — "AABB..." ≠ "aabb...".
    const providedDigest = crypto
      .createHash('sha256')
      .update(tokenCandidate, 'utf8')
      .digest();

    if (
      providedDigest.length !== DIGEST_BYTES ||
      this.configuredDigest.length !== DIGEST_BYTES
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!crypto.timingSafeEqual(providedDigest, this.configuredDigest)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return true;
  }
}
