import {
  bindExpirationInboundEvent,
  deriveExpirationSourceRequestId,
  EXPIRATION_SOURCE_NAMESPACE,
} from './expiration-source-identity';
import { deriveRestockSourceRequestId } from './restock-source-identity';

/**
 * EXPIRATION source-identity spec. The golden vector was computed independently
 * (Python `uuid.uuid5`) from this namespace and the UTF-8 name
 * `["EXPIRATION/v1","123456789012345","whatsapp:+5215500000001","wamid.ABC123"]`
 * so it is a frozen contract, not a re-derivation of the source under test.
 */
const GOLDEN_EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: 'whatsapp:+5215500000001',
  messageId: 'wamid.ABC123',
};
const GOLDEN = 'a5162346-c1f7-568d-905a-b76ffcd68278';
const RESTOCK_GOLDEN = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const withField = (o: Record<string, unknown>) => ({ ...GOLDEN_EVENT, ...o });

describe('deriveExpirationSourceRequestId', () => {
  it('freezes the namespace and matches the independent golden vector', () => {
    expect(EXPIRATION_SOURCE_NAMESPACE).toBe(
      '2b7d4c1a-6e8f-4a3b-9d2c-5f0a1b7e9c34',
    );
    expect(deriveExpirationSourceRequestId(GOLDEN_EVENT)).toBe(GOLDEN);
    expect(deriveExpirationSourceRequestId(withField({}))).toBe(GOLDEN);
  });

  it('always emits a canonical lowercase RFC4122 UUID version 5', () => {
    const id = deriveExpirationSourceRequestId(GOLDEN_EVENT);
    expect(id).toMatch(V5);
    expect(id).toBe(id?.toLowerCase());
  });

  it('is deterministic across repeated derivations', () => {
    expect(deriveExpirationSourceRequestId(GOLDEN_EVENT)).toBe(
      deriveExpirationSourceRequestId(GOLDEN_EVENT),
    );
  });

  it('yields a distinct id when any single field changes', () => {
    const variants = [
      withField({ receivingPhoneNumberId: '999999999999999' }),
      withField({ senderId: 'whatsapp:+5215500000002' }),
      withField({ messageId: 'wamid.ABC124' }),
    ].map(deriveExpirationSourceRequestId);
    expect(variants).not.toContain(GOLDEN);
    expect(new Set(variants).size).toBe(3);
  });

  it('differs from the RESTOCK id for the reference inbound tuple', () => {
    expect(deriveRestockSourceRequestId(GOLDEN_EVENT)).toBe(RESTOCK_GOLDEN);
    expect(deriveExpirationSourceRequestId(GOLDEN_EVENT)).not.toBe(
      RESTOCK_GOLDEN,
    );
  });

  it('binds bytes only: a syntactically valid tuple is not provenance proof', () => {
    // An ops/synthetic turn forwarding the same fields is indistinguishable.
    expect(deriveExpirationSourceRequestId({ ...GOLDEN_EVENT })).toBe(GOLDEN);
  });

  it('does not alias a shifted field boundary or a case change', () => {
    const left = deriveExpirationSourceRequestId(
      withField({ senderId: 'AB', messageId: 'C' }),
    );
    const right = deriveExpirationSourceRequestId(
      withField({ senderId: 'A', messageId: 'BC' }),
    );
    expect(left).not.toBe(right);
    expect(
      deriveExpirationSourceRequestId(
        withField({ senderId: 'WhatsApp:+5215500000001' }),
      ),
    ).not.toBe(GOLDEN);
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
      'EXPIRATION/v1',
      [],
      withField({ extra: 'x' }),
      { receivingPhoneNumberId: '1', senderId: 'a' },
      withField({ messageId: undefined }),
      Object.create(GOLDEN_EVENT),
      accessor,
    ];
    for (const value of absent) {
      expect(deriveExpirationSourceRequestId(value)).toBeNull();
    }
  });

  it('fails closed on a Proxy whose reads diverge from its descriptors', () => {
    const proxied = new Proxy({ ...GOLDEN_EVENT }, { get: () => 'tampered' });
    expect(deriveExpirationSourceRequestId(proxied)).toBeNull();
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
        deriveExpirationSourceRequestId(
          new Proxy({ ...GOLDEN_EVENT }, handler),
        ),
      ).toBeNull();
    }
    const revoked = Proxy.revocable({ ...GOLDEN_EVENT }, {});
    revoked.revoke();
    expect(deriveExpirationSourceRequestId(revoked.proxy)).toBeNull();
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
      expect(deriveExpirationSourceRequestId(value)).toBeNull();
    }
  });

  it('never mutates its input and accepts a frozen event', () => {
    const frozen = Object.freeze({ ...GOLDEN_EVENT });
    expect(deriveExpirationSourceRequestId(frozen)).toBe(GOLDEN);
    const input = { ...GOLDEN_EVENT };
    deriveExpirationSourceRequestId(input);
    expect(input).toEqual(GOLDEN_EVENT);
    expect(Object.keys(input)).toEqual([
      'receivingPhoneNumberId',
      'senderId',
      'messageId',
    ]);
  });
});

describe('bindExpirationInboundEvent', () => {
  const SENDER = GOLDEN_EVENT.senderId;

  it('binds a valid event to a frozen detached copy and the golden id', () => {
    const bound = bindExpirationInboundEvent(GOLDEN_EVENT, SENDER);
    expect(bound).not.toBeNull();
    expect(bound?.event).toEqual(GOLDEN_EVENT);
    expect(bound?.event).not.toBe(GOLDEN_EVENT);
    expect(Object.isFrozen(bound?.event)).toBe(true);
    expect(bound?.sourceRequestId).toBe(GOLDEN);
    expect(deriveExpirationSourceRequestId(bound?.event)).toBe(GOLDEN);
  });

  it('rejects a sender that does not match the trusted expected sender', () => {
    expect(
      bindExpirationInboundEvent(GOLDEN_EVENT, 'whatsapp:+5215500000999'),
    ).toBeNull();
    expect(bindExpirationInboundEvent(GOLDEN_EVENT, '')).toBeNull();
    expect(bindExpirationInboundEvent(GOLDEN_EVENT, 'whatsapp:...')).toBeNull();
  });

  it('rejects malformed, extra-key, missing-key, and non-object input', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'EXPIRATION/v1',
      [],
      withField({ extra: 'x' }),
      { receivingPhoneNumberId: '123', senderId: SENDER },
      withField({ messageId: 123 }),
    ];
    for (const value of bad) {
      expect(bindExpirationInboundEvent(value, SENDER)).toBeNull();
    }
  });

  it('rejects a rotating getter that changes value across reads', () => {
    let reads = 0;
    const rotating = new Proxy(
      { ...GOLDEN_EVENT },
      {
        get: (target, property) => {
          reads += 1;
          return reads % 2 !== 0
            ? (Reflect.get(target, property) as unknown)
            : 'tampered';
        },
      },
    );
    expect(bindExpirationInboundEvent(rotating, SENDER)).toBeNull();
  });

  it('rejects a throwing getter without throwing', () => {
    const throwing: Record<string, unknown> = {};
    for (const key of Object.keys(GOLDEN_EVENT)) {
      Object.defineProperty(throwing, key, {
        get: () => {
          throw new Error('boom');
        },
        enumerable: true,
      });
    }
    expect(() => bindExpirationInboundEvent(throwing, SENDER)).not.toThrow();
    expect(bindExpirationInboundEvent(throwing, SENDER)).toBeNull();
  });

  it('returns an immutable copy unaffected by later mutation of the source', () => {
    const source = { ...GOLDEN_EVENT };
    const bound = bindExpirationInboundEvent(source, SENDER);
    source.messageId = 'wamid.MUTATED';
    expect(bound?.event.messageId).toBe(GOLDEN_EVENT.messageId);
    expect(bound?.sourceRequestId).toBe(GOLDEN);
  });
});
