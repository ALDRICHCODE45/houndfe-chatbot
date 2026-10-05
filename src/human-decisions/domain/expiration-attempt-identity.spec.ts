import {
  EXPIRATION_ATTEMPT_NAMESPACE,
  deriveExpirationAttemptId,
} from './expiration-attempt-identity';
import {
  RESTOCK_ATTEMPT_NAMESPACE,
  deriveRestockAttemptId,
} from './restock-attempt-identity';

const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '99999999-9999-4999-8999-999999999999';
const GOLDEN = '6e57b252-319e-5a2c-a23e-d2bd5f5ebc43';
const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Independent vectors computed with Python's uuid.uuid5, namespace
 * c2308181-dd04-4389-b8c3-148e570b496c and UTF-8 compact JSON:
 * ["EXPIRATION_ATTEMPT/v1", lower source id, lower decision id, 2].
 * Expected values are literals, not computed with the implementation's helper. */
describe('deriveExpirationAttemptId', () => {
  it('pins the namespace and exact tagged tuple to an independent vector', () => {
    expect(EXPIRATION_ATTEMPT_NAMESPACE).toBe(
      'c2308181-dd04-4389-b8c3-148e570b496c',
    );
    expect(deriveExpirationAttemptId(SOURCE, DECISION)).toBe(GOLDEN);
  });

  it('is stable across repeated calls without storing a generated mapping', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(deriveExpirationAttemptId(SOURCE, DECISION)).toBe(GOLDEN);
    }
  });

  it.each([
    [SOURCE.toUpperCase(), DECISION],
    [SOURCE, DECISION.toUpperCase()],
    [SOURCE.toUpperCase(), DECISION.toUpperCase()],
  ])(
    'aliases UUID case spelling without creating a new attempt (%#)',
    (source, decision) => {
      expect(deriveExpirationAttemptId(source, decision)).toBe(GOLDEN);
    },
  );

  it.each([
    [OTHER, DECISION, '42214660-d613-5dd5-93e2-a7d8aca91c0c'],
    [SOURCE, OTHER, 'ad379f5e-e737-5ead-9896-d96a2e078523'],
    [DECISION, SOURCE, '91b41068-2317-5eaf-bd64-8303843d177a'],
  ])(
    'binds both ids and their order to independent vectors (%#)',
    (source, decision, expected) => {
      const id = deriveExpirationAttemptId(source, decision);
      expect(id).toBe(expected);
      expect(id).not.toBe(GOLDEN);
      expect(id).toMatch(UUID_V5);
    },
  );

  it('returns a lowercase UUIDv5 distinct from either input and RESTOCK', () => {
    const id = deriveExpirationAttemptId(SOURCE, DECISION);
    expect(id).toMatch(UUID_V5);
    expect(id).toBe(id?.toLowerCase());
    expect(id).not.toBe(SOURCE);
    expect(id).not.toBe(DECISION);
    expect(EXPIRATION_ATTEMPT_NAMESPACE).not.toBe(RESTOCK_ATTEMPT_NAMESPACE);
    expect(deriveRestockAttemptId(SOURCE, DECISION)).toBe(
      'a8c9e2cf-338e-50ad-a49b-3de5a82e4e8e',
    );
    expect(id).not.toBe(deriveRestockAttemptId(SOURCE, DECISION));
  });

  it.each<unknown>([
    undefined,
    null,
    true,
    42,
    1n,
    Symbol('id'),
    {},
    [],
    () => SOURCE,
    '',
    '   ',
    SOURCE.slice(0, -1),
    `${SOURCE}0`,
    ` ${SOURCE}`,
    `${SOURCE} `,
    `${SOURCE}\n`,
    SOURCE.replace('-', '_'),
    SOURCE.replace(/[0-9a-f]/, 'z'),
    SOURCE.replaceAll('-', ''),
  ])(
    'rejects malformed inputs in either position without throwing (%#)',
    (value) => {
      expect(deriveExpirationAttemptId(value, DECISION)).toBeNull();
      expect(deriveExpirationAttemptId(SOURCE, value)).toBeNull();
      expect(deriveExpirationAttemptId(value, value)).toBeNull();
    },
  );

  it('rejects objects without coercion or property access', () => {
    const read = jest.fn(() => {
      throw new Error('must not inspect non-string ids');
    });
    const hostile = new Proxy({}, { get: read });
    const boxed = Object(SOURCE) as unknown;
    for (const value of [hostile, boxed]) {
      expect(deriveExpirationAttemptId(value, DECISION)).toBeNull();
      expect(deriveExpirationAttemptId(SOURCE, value)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
  });
});
