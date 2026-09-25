import {
  deriveRestockSourceRequestId,
  RESTOCK_SOURCE_NAMESPACE,
} from './restock-source-identity';

/**
 * R3b3-c4b pure deterministic binding spec. The golden vector below was
 * computed independently (Python `uuid.uuid5`) from this exact namespace and the
 * UTF-8 name `["RESTOCK/v1","123456789012345","whatsapp:+5215500000001","wamid.ABC123"]`,
 * so it is a frozen contract, not a re-derivation of the source under test.
 */
const GOLDEN_EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: 'whatsapp:+5215500000001',
  messageId: 'wamid.ABC123',
};
const GOLDEN = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const withField = (o: Record<string, unknown>) => ({
  ...GOLDEN_EVENT,
  ...o,
});

describe('deriveRestockSourceRequestId', () => {
  it('freezes the namespace and matches the independent golden vector', () => {
    expect(RESTOCK_SOURCE_NAMESPACE).toBe(
      '4f3f1a2e-9c7b-4d1e-8a2f-6b5c0d9e1f23',
    );
    expect(deriveRestockSourceRequestId(GOLDEN_EVENT)).toBe(GOLDEN);
    expect(deriveRestockSourceRequestId(withField({}))).toBe(GOLDEN);
  });

  it('always emits a canonical RFC4122 UUID version 5', () => {
    const id = deriveRestockSourceRequestId(GOLDEN_EVENT);
    expect(id).not.toBeNull();
    expect(id).toMatch(V5);
    expect(id).toBe(id?.toLowerCase());
  });

  it('yields a distinct id when any single field changes', () => {
    const variants = [
      withField({ receivingPhoneNumberId: '999999999999999' }),
      withField({ senderId: 'whatsapp:+5215500000002' }),
      withField({ messageId: 'wamid.ABC124' }),
    ].map(deriveRestockSourceRequestId);
    expect(variants).not.toContain(GOLDEN);
    expect(new Set(variants).size).toBe(3);
  });

  it('does not alias a shifted field boundary or a case change', () => {
    const left = deriveRestockSourceRequestId(
      withField({ senderId: 'AB', messageId: 'C' }),
    );
    const right = deriveRestockSourceRequestId(
      withField({ senderId: 'A', messageId: 'BC' }),
    );
    expect(left).not.toBe(right);
    const upper = deriveRestockSourceRequestId(
      withField({ senderId: 'WhatsApp:+5215500000001' }),
    );
    expect(upper).not.toBe(GOLDEN);
  });

  it('fails closed on missing, extra, inherited, or accessor fields', () => {
    const accessor = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries(GOLDEN_EVENT)) {
      Object.defineProperty(accessor, key, {
        get: () => value,
        enumerable: true,
      });
    }
    const absent = [
      undefined,
      null,
      'RESTOCK/v1',
      [],
      withField({ extra: 'x' }),
      { receivingPhoneNumberId: '1', senderId: 'a' },
      withField({ messageId: undefined }),
      Object.create(GOLDEN_EVENT),
      accessor,
    ];
    for (const value of absent) {
      expect(deriveRestockSourceRequestId(value)).toBeNull();
    }
  });

  it('fails closed on a Proxy whose reads diverge from its descriptors', () => {
    const proxied = new Proxy({ ...GOLDEN_EVENT }, { get: () => 'tampered' });
    expect(deriveRestockSourceRequestId(proxied)).toBeNull();
  });

  it('returns null instead of throwing on hostile or revoked Proxy traps', () => {
    const throws = (): never => {
      throw new Error('hostile trap');
    };
    const traps: ProxyHandler<typeof GOLDEN_EVENT>[] = [
      { getPrototypeOf: throws },
      { ownKeys: throws },
      { getOwnPropertyDescriptor: throws },
      { get: throws },
    ];
    for (const handler of traps) {
      expect(
        deriveRestockSourceRequestId(new Proxy({ ...GOLDEN_EVENT }, handler)),
      ).toBeNull();
    }
    const revoked = Proxy.revocable({ ...GOLDEN_EVENT }, {});
    revoked.revoke();
    expect(deriveRestockSourceRequestId(revoked.proxy)).toBeNull();
  });

  it('fails closed on blank, padded, non-digit, or over-long identities', () => {
    const bad = [
      withField({ receivingPhoneNumberId: '' }),
      withField({ receivingPhoneNumberId: '12a456789012345' }),
      withField({ receivingPhoneNumberId: '+521' }),
      withField({ receivingPhoneNumberId: '123 456' }),
      withField({ receivingPhoneNumberId: '1'.repeat(25) }),
      withField({ senderId: '' }),
      withField({ senderId: '   ' }),
      withField({ senderId: ' whatsapp:+5215500000001' }),
      withField({ senderId: 'whatsapp:+5215500000001 ' }),
      withField({ senderId: 'a'.repeat(201) }),
      withField({ messageId: '' }),
      withField({ messageId: 'wamid.ABC123 ' }),
      withField({ messageId: 'x'.repeat(513) }),
      withField({ messageId: 123 }),
    ];
    for (const value of bad) {
      expect(deriveRestockSourceRequestId(value)).toBeNull();
    }
  });

  it('never mutates its input and accepts a frozen event', () => {
    const frozen = Object.freeze({ ...GOLDEN_EVENT });
    expect(deriveRestockSourceRequestId(frozen)).toBe(GOLDEN);
    const input = { ...GOLDEN_EVENT };
    deriveRestockSourceRequestId(input);
    expect(input).toEqual(GOLDEN_EVENT);
    expect(Object.keys(input)).toEqual([
      'receivingPhoneNumberId',
      'senderId',
      'messageId',
    ]);
  });
});
