/** WU6D1 application capability authorizer (design "Reviewer access"): a
 *  closed discriminated authorization result over the WU6A token primitive
 *  and the WU6B hash lookup. Malformed tokens deny with zero lookups; every
 *  well-formed token — known or unknown — receives the fixed-dummy
 *  timing-safe comparison BEFORE the row-existence/revocation decision.
 *  Database rejections map to the closed unavailable result with no
 *  exception detail. No storage, HTTP, logging, or wiring surface. */
import { Inject } from '@nestjs/common';
import { CapabilityService } from './capability.service';
import type { CapabilityAccessRow } from '../domain/receipt-media-store.port';

/** Narrow lookup seam over the WU6B store capability lookup; keeps
 *  PostgreSQL infrastructure out of the application layer. */
export const RECEIPT_CAPABILITY_LOOKUP = Symbol('RECEIPT_CAPABILITY_LOOKUP');

export interface ReceiptCapabilityLookup {
  lookupByCapabilityHash(hash: Buffer): Promise<CapabilityAccessRow | null>;
}

/** Closed result: only the opaque object key is exposed on success; denials
 *  and infrastructure unavailability carry no row, exception, or token
 *  detail, so callers cannot distinguish unknown/altered/revoked tokens. */
export type ReceiptCapabilityAuthorization =
  | { kind: 'authorized'; objectKey: string }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

export class ReceiptCapabilityAuthorizerService {
  constructor(
    private readonly capabilityService: CapabilityService,
    @Inject(RECEIPT_CAPABILITY_LOOKUP)
    private readonly lookup: ReceiptCapabilityLookup,
  ) {}

  async authorize(rawToken: unknown): Promise<ReceiptCapabilityAuthorization> {
    const tokenHash = this.capabilityService.hashToken(rawToken);
    if (tokenHash === null) return { kind: 'denied' };
    let row: CapabilityAccessRow | null;
    try {
      row = await this.lookup.lookupByCapabilityHash(tokenHash);
    } catch {
      return { kind: 'unavailable' };
    }
    // The timing-safe comparison always runs first — against the stored hash
    // or the fixed dummy (null) for unknown rows — so token existence is
    // never decidable from comparison timing before the row decision.
    const verified = this.capabilityService.verify(
      rawToken as string,
      row?.capabilityTokenHash ?? null,
    );
    if (row === null || !verified || row.capabilityRevokedAt !== null) {
      return { kind: 'denied' };
    }
    return { kind: 'authorized', objectKey: row.objectKey };
  }
}
