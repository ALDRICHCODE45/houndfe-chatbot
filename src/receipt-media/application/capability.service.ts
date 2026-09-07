/** WU6A capability token primitive (design 339-357): deterministic HMAC-SHA256
 *  issuance, strict canonical parsing, hash-only lookup input, fixed-dummy
 *  timing-safe comparison, and version-safe reconstruction over a decoded
 *  keyring. Pure constructor-input service: no Nest, config, database, storage,
 *  URL, logging, or lookup dependency; failures never carry secret material. */
import * as nodeCrypto from 'node:crypto';

const TOKEN_ALPHABET_RE = /^[A-Za-z0-9_-]{43}$/;
/** Same canonical UUID-v4 convention as the object key (object-storage.port). */
const RECEIPT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_MESSAGE_PREFIX = 'receipt-media-capability:v1:';
const KEYRING_INVALID = 'RECEIPT_CAPABILITY_KEYRING_INVALID';
const INPUT_INVALID = 'RECEIPT_CAPABILITY_INPUT_INVALID';
const HASH_BYTES = 32;
/** Fixed constant so missing/wrong-length stored hashes still compare as an
 *  actual 32-byte timingSafeEqual call. */
const DUMMY_HASH = Buffer.alloc(HASH_BYTES);

export interface CapabilityTokenResult {
  token: string;
  tokenHash: Buffer;
  keyVersion: number;
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Fail-closed stored-hash candidate. Recognition runs entirely inside
 *  the try: the Object.prototype.toString tag read executes attacker
 *  getters on hostile Proxies, and Symbol.toStringTag can spoof the tag
 *  into '[object Uint8Array]' — so the genuine-brand ArrayBuffer.isView
 *  internal-slot check, length check, and defensive copy gate the rest. */
const asHashCandidate = (value: unknown): Uint8Array | null => {
  try {
    if (Object.prototype.toString.call(value) !== '[object Uint8Array]') {
      return null;
    }
    if (!ArrayBuffer.isView(value)) return null;
    const view = value as Uint8Array;
    if (view.length !== HASH_BYTES) return null;
    const copy = Buffer.from(view);
    return copy.length === HASH_BYTES ? copy : null;
  } catch {
    return null;
  }
};

export class CapabilityService {
  private readonly keys: Map<number, Buffer>;

  constructor(
    keys: ReadonlyMap<number, Uint8Array>,
    private readonly activeVersion: number,
  ) {
    if (!(keys instanceof Map) || keys.size === 0) {
      throw new Error(KEYRING_INVALID);
    }
    this.keys = new Map();
    for (const [version, key] of keys) {
      if (
        !isPositiveInt(version) ||
        !(key instanceof Uint8Array) ||
        key.length < HASH_BYTES
      ) {
        throw new Error(KEYRING_INVALID);
      }
      // Defensive copy keeps each version's material stable against later
      // mutation of the caller's buffers.
      this.keys.set(version, Buffer.from(key));
    }
    if (!this.keys.has(activeVersion)) {
      throw new Error(KEYRING_INVALID);
    }
  }

  issue(receiptUuid: string): CapabilityTokenResult {
    if (typeof receiptUuid !== 'string' || !RECEIPT_UUID_RE.test(receiptUuid)) {
      throw new Error(INPUT_INVALID);
    }
    return {
      ...this.derive(receiptUuid, this.activeVersion),
      keyVersion: this.activeVersion,
    };
  }

  /** Strict canonical parse: 43 base64url chars decoding to 32 bytes and
   *  re-encoding identically (rejects padding, foreign alphabet, wrong
   *  length, and noncanonical trailing bits). */
  parseToken(raw: unknown): string | null {
    if (typeof raw !== 'string' || !TOKEN_ALPHABET_RE.test(raw)) return null;
    const decoded = Buffer.from(raw, 'base64url');
    return decoded.length === HASH_BYTES &&
      decoded.toString('base64url') === raw
      ? raw
      : null;
  }
  /** SHA-256 lookup input for the strict-parsed token; null if malformed. */
  hashToken(raw: unknown): Buffer | null {
    const token = this.parseToken(raw);
    if (token === null) return null;
    return nodeCrypto.createHash('sha256').update(token, 'ascii').digest();
  }

  /** Timing-safe stored-hash verification; always compares exactly 32 bytes
   *  against the stored hash or the fixed dummy. Never throws. */
  verify(token: string, storedHash: unknown): boolean {
    const parsed = this.parseToken(token);
    if (parsed === null) return false;
    const actual = nodeCrypto
      .createHash('sha256')
      .update(parsed, 'ascii')
      .digest();
    const candidate = asHashCandidate(storedHash) ?? DUMMY_HASH;
    return nodeCrypto.timingSafeEqual(actual, candidate);
  }

  /** Rebuilds the token from the persisted key version and verifies it
   *  timing-safely; missing/changed keys, unknown versions, and mismatches
   *  all fail closed to null. */
  reconstruct(
    receiptUuid: string,
    keyVersion: number,
    storedHash: unknown,
  ): CapabilityTokenResult | null {
    if (typeof receiptUuid !== 'string' || !RECEIPT_UUID_RE.test(receiptUuid)) {
      return null;
    }
    if (!isPositiveInt(keyVersion) || !this.keys.has(keyVersion)) return null;
    const derived = this.derive(receiptUuid, keyVersion);
    if (!this.verify(derived.token, storedHash)) return null;
    return { ...derived, keyVersion };
  }

  private derive(
    receiptUuid: string,
    keyVersion: number,
  ): Omit<CapabilityTokenResult, 'keyVersion'> {
    const mac = nodeCrypto
      .createHmac('sha256', this.keys.get(keyVersion) as Buffer)
      .update(TOKEN_MESSAGE_PREFIX + receiptUuid, 'ascii')
      .digest();
    const token = mac.toString('base64url');
    return {
      token,
      tokenHash: nodeCrypto
        .createHash('sha256')
        .update(token, 'ascii')
        .digest(),
    };
  }
}
