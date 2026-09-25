import {
  RESTOCK_ATTEMPT_NAMESPACE,
  deriveRestockAttemptId,
} from './restock-attempt-identity';

/**
 * T4c0 pure deterministic attempt-identity spec. `G` was computed independently
 * (Python `uuid.uuid5`) from namespace `7b1c9e2d-4a35-4f60-9c18-2d3e5a7b8c91`
 * and the UTF-8 name
 * `["RESTOCK_ATTEMPT/v1","848d8b89-...","a1b2c3d4-...",2]`, so it is a frozen
 * contract vector, not a re-derivation of the source under test.
 */
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const DID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '99999999-9999-4999-8999-999999999999';
const G = 'a8c9e2cf-338e-50ad-a49b-3de5a82e4e8e';
const V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveRestockAttemptId', () => {
  it('freezes the namespace and matches the independent golden vector', () => {
    expect(RESTOCK_ATTEMPT_NAMESPACE).toBe(
      '7b1c9e2d-4a35-4f60-9c18-2d3e5a7b8c91',
    );
    expect(deriveRestockAttemptId(SRC, DID)).toBe(G);
  });

  it('is stable across repeated calls for the exact same tuple', () => {
    const first = deriveRestockAttemptId(SRC, DID);
    expect(first).toBe(G);
    expect(deriveRestockAttemptId(SRC, DID)).toBe(G);
    expect(deriveRestockAttemptId(SRC, DID)).toBe(first);
  });

  it('aliases an uppercase spelling of the same ids to the golden id', () => {
    expect(deriveRestockAttemptId(SRC.toUpperCase(), DID.toUpperCase())).toBe(
      G,
    );
    expect(deriveRestockAttemptId(SRC.toUpperCase(), DID)).toBe(G);
    expect(deriveRestockAttemptId(SRC, DID.toUpperCase())).toBe(G);
  });

  it('yields a distinct id when source or decision changes', () => {
    const otherSrc = deriveRestockAttemptId(OTHER, DID);
    const otherDid = deriveRestockAttemptId(SRC, OTHER);
    expect(otherSrc).not.toBe(G);
    expect(otherDid).not.toBe(G);
    expect(otherSrc).not.toBe(otherDid);
    expect(deriveRestockAttemptId(OTHER, OTHER)).not.toBe(G);
  });

  it('always emits a canonical RFC4122 UUID version 5, distinct from inputs', () => {
    const id = deriveRestockAttemptId(SRC, DID);
    expect(id).toMatch(V5);
    expect(id).toBe(id?.toLowerCase());
    expect(id).not.toBe(SRC);
    expect(id).not.toBe(DID);
  });

  it('fails closed on malformed or ambiguous ids', () => {
    const bad = [
      undefined,
      null,
      42,
      {},
      [],
      '',
      '   ',
      SRC.slice(0, -1),
      ` ${SRC}`,
      `${SRC} `,
      SRC.replace('-', '_'),
      SRC.replace(/[0-9a-f]/, 'z'),
      `${SRC}0`,
      '848d8b89b3235a4f952e41ebcc00d733',
    ];
    for (const value of bad) {
      expect(deriveRestockAttemptId(value, DID)).toBeNull();
      expect(deriveRestockAttemptId(SRC, value)).toBeNull();
      expect(deriveRestockAttemptId(value, value)).toBeNull();
    }
  });
});
