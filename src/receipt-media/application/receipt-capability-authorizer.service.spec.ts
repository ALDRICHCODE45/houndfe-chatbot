/** WU6D1 application authorizer spec (RMA2, RMA3): closed discriminated
 *  result, zero lookup for malformed tokens, and the exact unknown-row
 *  fixed-dummy verify ordering observed through a spy — not merely the
 *  returned kind. Uses the real CapabilityService; the lookup is a focused
 *  narrow-seam stub. */
import * as nodeCrypto from 'node:crypto';
import { CapabilityService } from './capability.service';
import {
  RECEIPT_CAPABILITY_LOOKUP,
  ReceiptCapabilityAuthorizerService,
  type ReceiptCapabilityLookup,
} from './receipt-capability-authorizer.service';
import type { CapabilityAccessRow } from '../domain/receipt-media-store.port';

const KEY = new Map([[1, new Uint8Array(nodeCrypto.randomBytes(32))]]);
const UUID = '5f0d5c1e-8a5b-4c9d-9e2f-3a4b5c6d7e8f';
const OTHER_UUID = '0f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';
const OBJECT_KEY = `receipts/${UUID}`;

const rowFor = (
  tokenHash: Buffer,
  revokedAt: Date | null = null,
): CapabilityAccessRow => ({
  id: UUID,
  objectKey: OBJECT_KEY,
  capabilityTokenHash: tokenHash,
  capabilityRevokedAt: revokedAt,
});

const buildHarness = (row: CapabilityAccessRow | null, reject = false) => {
  const capabilityService = new CapabilityService(KEY, 1);
  const verifySpy = jest.spyOn(capabilityService, 'verify');
  const lookupSpy = reject
    ? jest
        .fn<Promise<CapabilityAccessRow | null>, [Buffer]>()
        .mockRejectedValue(new Error('SECRET_DB_DETAIL'))
    : jest
        .fn<Promise<CapabilityAccessRow | null>, [Buffer]>()
        .mockResolvedValue(row);
  const lookup: ReceiptCapabilityLookup = {
    lookupByCapabilityHash: (hash) => lookupSpy(hash),
  };
  const service = new ReceiptCapabilityAuthorizerService(
    capabilityService,
    lookup,
  );
  return { service, verifySpy, lookupSpy };
};

describe('ReceiptCapabilityAuthorizerService', () => {
  it.each([
    ['42 chars', 'A'.repeat(42)],
    ['44 chars', 'A'.repeat(44)],
    ['padding suffix', `${'A'.repeat(43)}=`],
    ['foreign alphabet', `${'+'.repeat(42)}/a_`],
    ['noncanonical trailing bits', 'A'.repeat(42) + 'B'],
    ['empty token', ''],
  ])(
    'denies a malformed token (%s) with zero lookups',
    async (_label, rawToken) => {
      const { service, lookupSpy, verifySpy } = buildHarness(
        rowFor(Buffer.alloc(32)),
      );
      await expect(service.authorize(rawToken)).resolves.toEqual({
        kind: 'denied',
      });
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(verifySpy).not.toHaveBeenCalled();
    },
  );

  it('looks up a canonical 43-char token with zero pad bits (paired contrast)', async () => {
    const { service, lookupSpy } = buildHarness(null);
    await expect(service.authorize('A'.repeat(43))).resolves.toEqual({
      kind: 'denied',
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });

  it('authorizes a known valid token with only the objectKey', async () => {
    const capabilityService = new CapabilityService(KEY, 1);
    const issued = capabilityService.issue(UUID);
    const { service, verifySpy, lookupSpy } = buildHarness(
      rowFor(issued.tokenHash),
    );
    await expect(service.authorize(issued.token)).resolves.toEqual({
      kind: 'authorized',
      objectKey: OBJECT_KEY,
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy.mock.calls[0][0]).toEqual(issued.tokenHash);
    expect(verifySpy).toHaveBeenCalledWith(issued.token, issued.tokenHash);
  });

  it('verifies an unknown token against the fixed dummy BEFORE the row decision', async () => {
    const capabilityService = new CapabilityService(KEY, 1);
    const issued = capabilityService.issue(OTHER_UUID);
    const { service, verifySpy, lookupSpy } = buildHarness(null);
    await expect(service.authorize(issued.token)).resolves.toEqual({
      kind: 'denied',
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    // Unknown row: the timing-safe comparison must still run once, against
    // null (the fixed dummy), before the row-existence decision.
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(issued.token, null);
  });

  it('denies a known token whose stored hash does not match', async () => {
    const capabilityService = new CapabilityService(KEY, 1);
    const issued = capabilityService.issue(UUID);
    const { service, verifySpy } = buildHarness(
      rowFor(issued.tokenHash.slice()),
    );
    issued.tokenHash.fill(0);
    await expect(service.authorize(issued.token)).resolves.toEqual({
      kind: 'denied',
    });
    expect(verifySpy).toHaveBeenCalledWith(issued.token, expect.any(Buffer));
  });

  it('denies a well-formed token against a malformed 31-byte stored hash', async () => {
    const capabilityService = new CapabilityService(KEY, 1);
    const issued = capabilityService.issue(UUID);
    const shortHash = Buffer.alloc(31);
    const { service, verifySpy, lookupSpy } = buildHarness(rowFor(shortHash));
    await expect(service.authorize(issued.token)).resolves.toEqual({
      kind: 'denied',
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(issued.token, shortHash);
  });

  it('denies a revoked row and verifies before the revocation decision', async () => {
    const capabilityService = new CapabilityService(KEY, 1);
    const issued = capabilityService.issue(UUID);
    const { service, verifySpy } = buildHarness(
      rowFor(issued.tokenHash, new Date('2026-01-01T00:00:00Z')),
    );
    await expect(service.authorize(issued.token)).resolves.toEqual({
      kind: 'denied',
    });
    expect(verifySpy).toHaveBeenCalledWith(issued.token, issued.tokenHash);
  });

  it('maps a database rejection to unavailable with no exception detail', async () => {
    const capabilityService = new CapabilityService(KEY, 1);
    const issued = capabilityService.issue(UUID);
    const { service, verifySpy, lookupSpy } = buildHarness(null, true);
    const outcome = await service.authorize(issued.token);
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain('SECRET_DB_DETAIL');
  });

  it('exports the narrow application lookup seam token', () => {
    expect(typeof RECEIPT_CAPABILITY_LOOKUP).toBe('symbol');
  });
});
