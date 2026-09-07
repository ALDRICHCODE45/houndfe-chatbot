import { timingSafeEqual } from 'node:crypto';
import { CapabilityService } from './capability.service';

// Pass-through spy wrapper so dummy-comparison calls are observable without
// altering verification behavior.
jest.mock('node:crypto', () => {
  const actual =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

const safeEqual = jest.mocked(timingSafeEqual);
const UUID_A = '00000000-0000-4000-8000-000000000000';
const UUID_B = '11111111-1111-4111-8111-111111111111';
// Independent fixed vector (computed outside this suite): HMAC-SHA256 over
// ASCII "receipt-media-capability:v1:" + UUID_A with the 32-byte key below.
const KEY_V1_HEX =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY_V1 = Buffer.from(KEY_V1_HEX, 'hex');
const KEY_V2 = Buffer.alloc(32, 0xab);
const VECTOR_TOKEN = 'x9iX38HtKUXB_SwlpcZZWuxx_4BCM5OZC60KAKivZCw';
const VECTOR_HASH = Buffer.from(
  'ad9eecc3c5c792a23159032b3e78e6897a367ba130e1c80ba6f6c58fdb590723',
  'hex',
);
// Spoofed-tag array-like: passes the toString gate, must still use dummy.
const SPOOF = { [Symbol.toStringTag]: 'Uint8Array', length: 32 };
const KEYRING_INVALID = 'RECEIPT_CAPABILITY_KEYRING_INVALID';
const INPUT_INVALID = 'RECEIPT_CAPABILITY_INPUT_INVALID';
const make = (
  keys: ReadonlyMap<number, Buffer>,
  activeVersion = 1,
): CapabilityService => new CapabilityService(keys, activeVersion);
const rotated = (): CapabilityService =>
  make(
    new Map([
      [1, KEY_V1],
      [2, KEY_V2],
    ]),
    2,
  );

describe('CapabilityService', () => {
  it('issues the fixed vector deterministically and differently per id', () => {
    const issued = make(new Map([[1, KEY_V1]])).issue(UUID_A);
    expect(issued.token).toBe(VECTOR_TOKEN);
    expect(issued.token.length).toBe(43);
    expect(issued.tokenHash.equals(VECTOR_HASH)).toBe(true);
    expect(issued.keyVersion).toBe(1);
    const restarted = make(new Map([[1, Buffer.from(KEY_V1)]])).issue(UUID_A);
    expect(restarted.token).toBe(issued.token);
    expect(restarted.tokenHash.equals(issued.tokenHash)).toBe(true);
    const other = make(new Map([[1, KEY_V1]])).issue(UUID_B);
    expect(other.token).not.toBe(issued.token);
    expect(other.tokenHash.equals(issued.tokenHash)).toBe(false);
  });

  it('rotates additively, retains old keys, and copies key buffers', () => {
    const service = rotated();
    const fresh = service.issue(UUID_A);
    expect(fresh.keyVersion).toBe(2);
    expect(fresh.token).not.toBe(VECTOR_TOKEN);
    const legacy = make(new Map([[1, KEY_V1]])).issue(UUID_A);
    const back = service.reconstruct(UUID_A, 1, legacy.tokenHash);
    expect(back?.token).toBe(legacy.token);
    expect(back?.keyVersion).toBe(1);
    const mutable = Buffer.from(KEY_V1);
    const copying = make(new Map([[1, mutable]]));
    const before = copying.issue(UUID_A);
    mutable.fill(0xff);
    expect(copying.issue(UUID_A).token).toBe(before.token);
  });

  it('fails closed when a historical key is absent or replaced', () => {
    const legacy = make(new Map([[1, KEY_V1]])).issue(UUID_A);
    const withoutOld = make(new Map([[2, KEY_V2]]), 2);
    expect(withoutOld.reconstruct(UUID_A, 1, legacy.tokenHash)).toBeNull();
    expect(withoutOld.reconstruct(UUID_A, 3, legacy.tokenHash)).toBeNull();
    const replaced = make(
      new Map([
        [1, KEY_V2],
        [2, Buffer.alloc(32, 0xcd)],
      ]),
      2,
    );
    expect(replaced.reconstruct(UUID_A, 1, legacy.tokenHash)).toBeNull();
  });

  describe('token parsing', () => {
    const service = make(new Map([[1, KEY_V1]]));
    it('accepts only the canonical 43-char base64url token', () => {
      expect(service.parseToken(VECTOR_TOKEN)).toBe(VECTOR_TOKEN);
      // Same decoded bytes as the canonical token, but trailing bits differ.
      const noncanonical = VECTOR_TOKEN.slice(0, 42) + 'x';
      expect(
        Buffer.from(noncanonical, 'base64url').equals(
          Buffer.from(VECTOR_TOKEN, 'base64url'),
        ),
      ).toBe(true);
      const bad = [
        VECTOR_TOKEN + '=', // padded
        ' ' + VECTOR_TOKEN.slice(1), // whitespace inside 43 chars
        VECTOR_TOKEN.slice(0, 42) + '+', // '+' is not base64url
        VECTOR_TOKEN.slice(0, 42) + '/', // '/' is not base64url
        VECTOR_TOKEN.slice(0, 42), // 42 chars
        VECTOR_TOKEN + 'A', // 44 chars
        noncanonical, // noncanonical trailing bits
        null,
        undefined,
        42,
      ];
      for (const raw of bad)
        expect(service.parseToken(raw as string)).toBeNull();
    });
  });

  describe('hash and verify', () => {
    const service = make(new Map([[1, KEY_V1]]));
    const lastArgs = (): [Buffer, Buffer] =>
      safeEqual.mock.calls[safeEqual.mock.calls.length - 1] as [Buffer, Buffer];
    it('produces the lookup input consistently and rejects alterations', () => {
      const issued = service.issue(UUID_A);
      expect(service.hashToken(issued.token)?.equals(issued.tokenHash)).toBe(
        true,
      );
      expect(service.hashToken(issued.token + '=')).toBeNull();
      expect(
        service.verify(issued.token, service.hashToken(issued.token)),
      ).toBe(true);
      const altered = issued.token.slice(0, 42) + 'A';
      expect(altered).not.toBe(issued.token);
      expect(service.verify(altered, issued.tokenHash)).toBe(false);
    });
    it('compares a fixed 32-byte dummy when the stored hash is missing or wrong-length', () => {
      for (const bad of [
        null,
        undefined,
        Buffer.alloc(31, 0x11),
        Buffer.alloc(33, 0x11),
      ]) {
        safeEqual.mockClear();
        expect(service.verify(VECTOR_TOKEN, bad)).toBe(false);
        expect(safeEqual).toHaveBeenCalledTimes(1);
        const [actual, candidate] = lastArgs();
        expect(actual).toHaveLength(32);
        expect(candidate).toHaveLength(32);
        expect(candidate.equals(Buffer.alloc(32))).toBe(true);
      }
    });
    it('fails closed on proxied or spoofed stored hashes with one genuine 32-byte dummy comparison', () => {
      const hostile = new Proxy(Buffer.alloc(32), {
        get: () => {
          throw new Error('hostile get trap');
        },
      });
      for (const bad of [new Proxy(Buffer.alloc(32), {}), hostile, SPOOF]) {
        safeEqual.mockClear();
        expect(service.verify(VECTOR_TOKEN, bad)).toBe(false);
        expect(safeEqual).toHaveBeenCalledTimes(1);
        const [actual, candidate] = lastArgs();
        expect(actual).toHaveLength(32);
        expect(candidate).toHaveLength(32);
        expect(candidate.equals(Buffer.alloc(32))).toBe(true);
      }
      expect(service.verify(VECTOR_TOKEN, new Uint8Array(VECTOR_HASH))).toBe(
        true,
      );
      expect(service.reconstruct(UUID_A, 1, hostile)).toBeNull();
    });
    it('fails closed on malformed tokens without throwing or comparing', () => {
      safeEqual.mockClear();
      for (const bad of [VECTOR_TOKEN + '=', 'short', ''])
        expect(service.verify(bad, Buffer.alloc(32, 0x22))).toBe(false);
      expect(safeEqual).not.toHaveBeenCalled();
    });
  });

  describe('reconstruction', () => {
    const service = make(new Map([[1, KEY_V1]]));
    it('matches the issued token and fails closed on tampering', () => {
      const issued = service.issue(UUID_A);
      const back = service.reconstruct(UUID_A, 1, issued.tokenHash);
      expect(back?.token).toBe(issued.token);
      expect(back?.tokenHash.equals(issued.tokenHash)).toBe(true);
      expect(back?.keyVersion).toBe(1);
      const tampered = Buffer.from(issued.tokenHash);
      tampered[0] ^= 0x01;
      expect(service.reconstruct(UUID_A, 1, tampered)).toBeNull();
      for (const uuid of [null, 'not-a-uuid', 'receipts/' + UUID_A])
        expect(
          service.reconstruct(uuid as string, 1, issued.tokenHash),
        ).toBeNull();
      expect(service.reconstruct(UUID_A, 0, issued.tokenHash)).toBeNull();
      expect(service.reconstruct(UUID_A, 1.5, issued.tokenHash)).toBeNull();
    });
  });

  describe('fail-closed validation', () => {
    it('rejects invalid keyrings without exposing key material', () => {
      const cases: Array<[ReadonlyMap<number, Buffer>, number]> = [
        [new Map(), 1],
        [new Map([[1, Buffer.alloc(31, 0x01)]]), 1],
        [new Map([[1, KEY_V1]]), 2],
        [new Map([[0, KEY_V1]]), 0],
        [new Map([[1.5, KEY_V1]]), 1.5],
      ];
      for (const [keys, active] of cases)
        expect(() => make(keys, active)).toThrow(KEYRING_INVALID);
      expect(() => make(new Map([[1, Buffer.alloc(31, 0x01)]]), 1)).toThrow(
        new Error(KEYRING_INVALID),
      );
    });
    it('rejects non-canonical receipt uuids at issuance', () => {
      const service = make(new Map([[1, KEY_V1]]));
      const cases = [
        'not-a-uuid',
        '00000000-0000-4000-8000-00000000000G',
        '00000000-0000-1000-8000-000000000000',
        '00000000-0000-4000-c000-000000000000',
        '00000000000040008000000000000000',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase(),
        'receipts/' + UUID_A,
      ];
      for (const uuid of cases)
        expect(() => service.issue(uuid)).toThrow(INPUT_INVALID);
      expect(() => service.issue('not-a-uuid')).toThrow(
        new Error(INPUT_INVALID),
      );
    });
    it('performs no logging and carries no logger dependency', () => {
      const service = make(new Map([[1, KEY_V1]]));
      expect(Object.keys(service).sort()).toEqual(['activeVersion', 'keys']);
      expect(service.parseToken('')).toBeNull();
      expect(service.reconstruct(UUID_A, 99, null)).toBeNull();
    });
  });
});
