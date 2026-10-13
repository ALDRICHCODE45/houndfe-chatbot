import type { CheckoutContextAddress } from '../../chatbot-api/domain/dtos/checkout-context.dto';
import {
  MINIMAL_CHECKOUT_ADDRESS_REFERENCE_MAX,
  MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS,
  MinimalCheckoutAddressReferences,
  type MinimalCheckoutAddressOffer,
  type MinimalCheckoutAddressPage,
  type MinimalCheckoutNextPage,
  type ResolvedMinimalCheckoutAddress,
} from './minimal-checkout-address-references';

const SENDER = 'sender-1';
const CUSTOMER_ID = 'd4ef5012-4444-4444-8444-444444444444';
const OTHER_CUSTOMER_ID = 'e5f06123-5555-4555-8555-555555555555';
const ADDRESS_A = 'a1bc2def-1111-4111-8111-111111111111';
const ADDRESS_B = 'b2cd3ef0-2222-4222-8222-222222222222';
const ADDRESS_C = 'c3de4f01-3333-4333-8333-333333333333';
const ADDRESS_A_UPPER = 'A1BC2DEF-1111-4111-8111-111111111111';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const V9_UUID = 'a1bc2def-1111-9111-8111-111111111111';
const VERSION = '2026-06-22T10:30:00.000Z';
const VERSION_2 = '2026-06-23T08:00:00.000Z';

const CUSTOMER = { customerId: CUSTOMER_ID, firstName: 'Ana', lastName: null };

const address = (
  id: string,
  overrides: Partial<CheckoutContextAddress> = {},
): CheckoutContextAddress => ({
  id,
  version: VERSION,
  label: 'Casa',
  street: 'Av. Reforma 123',
  exteriorNumber: '123',
  interiorNumber: null,
  zipCode: '06600',
  neighborhood: 'Centro',
  municipality: 'Cuauhtémoc',
  city: 'CDMX',
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
  ...overrides,
});

const uuidFor = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const uniquePage = (
  addresses: CheckoutContextAddress[],
  options: { customer?: unknown; next?: boolean } = {},
): unknown => ({
  status: 'unique',
  customer: options.customer ?? CUSTOMER,
  addresses,
  nextAfterAddressId:
    options.next === true && addresses.length > 0
      ? addresses[addresses.length - 1].id
      : null,
});

const notFound = (): unknown => ({
  status: 'not_found',
  customer: null,
  addresses: [],
  nextAfterAddressId: null,
});

const ambiguous = (): unknown => ({
  status: 'ambiguous',
  customer: null,
  addresses: [],
  nextAfterAddressId: null,
});

function mustRegister(
  refs: MinimalCheckoutAddressReferences,
  input: Parameters<MinimalCheckoutAddressReferences['registerPage']>[0],
): MinimalCheckoutAddressPage {
  const result = refs.registerPage(input);
  if (result === null) throw new Error('expected a registered page');
  return result;
}

function mustResolve(
  refs: MinimalCheckoutAddressReferences,
  reference: unknown,
): ResolvedMinimalCheckoutAddress {
  const result = refs.resolveAddress(reference);
  if (result === null) throw new Error('expected a resolved address');
  return result;
}

function mustNext(
  refs: MinimalCheckoutAddressReferences,
  reference: unknown,
): MinimalCheckoutNextPage {
  const result = refs.resolveNextPage(reference);
  if (result === null) throw new Error('expected a next-page reference');
  return result;
}

function mustPage(
  refs: MinimalCheckoutAddressReferences,
  pageReference: unknown,
): MinimalCheckoutAddressPage {
  const result = refs.viewPage(pageReference);
  if (result === null) throw new Error('expected a viewed page');
  return result;
}

describe('MinimalCheckoutAddressReferences opaque sender-bound references', () => {
  it('returns a stable opaque reference that is never the raw identity', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const first = mustRegister(refs, {
      query: { limit: 10 },
      context: uniquePage([address(ADDRESS_A)]),
    });
    const second = mustRegister(refs, {
      query: { limit: 10 },
      context: uniquePage([address(ADDRESS_A)]),
    });
    const reference = first.addresses[0].reference;
    expect(reference).toMatch(/^[0-9a-f]{16}$/);
    expect(reference).toBe(second.addresses[0].reference);
    expect(reference).not.toContain(ADDRESS_A);
    expect(reference).not.toBe(ADDRESS_A);
  });

  it('gives distinct references to distinct saved addresses', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const result = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A), address(ADDRESS_B)]),
    });
    expect(result.addresses).toHaveLength(2);
    expect(result.addresses[0].reference).not.toBe(
      result.addresses[1].reference,
    );
  });

  it('keeps identifiers that differ only by case distinct', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const result = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A), address(ADDRESS_A_UPPER)]),
    });
    expect(result.addresses).toHaveLength(2);
    expect(result.addresses[0].reference).not.toBe(
      result.addresses[1].reference,
    );
    expect(mustResolve(refs, result.addresses[0].reference).address.id).toBe(
      ADDRESS_A,
    );
    expect(mustResolve(refs, result.addresses[1].reference).address.id).toBe(
      ADDRESS_A_UPPER,
    );
  });

  it('preserves uppercase, NIL and MAX identifiers plus the exact version', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const result = mustRegister(refs, {
      context: uniquePage([
        address(ADDRESS_A_UPPER),
        address(NIL_UUID),
        address(MAX_UUID, { version: VERSION_2 }),
      ]),
    });
    expect(mustResolve(refs, result.addresses[0].reference).address.id).toBe(
      ADDRESS_A_UPPER,
    );
    expect(mustResolve(refs, result.addresses[1].reference).address.id).toBe(
      NIL_UUID,
    );
    const last = mustResolve(refs, result.addresses[2].reference);
    expect(last.address.id).toBe(MAX_UUID);
    expect(last.address.version).toBe(VERSION_2);
  });

  it('never resolves a raw id or model-provided argument as a reference', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    mustRegister(refs, { context: uniquePage([address(ADDRESS_A)]) });
    expect(refs.resolveAddress(ADDRESS_A)).toBeNull();
    expect(refs.resolveAddress('1')).toBeNull();
    expect(refs.resolveAddress('')).toBeNull();
    expect(refs.resolveAddress(null)).toBeNull();
    expect(refs.resolveNextPage(ADDRESS_A)).toBeNull();
    expect(refs.resolveNextPage('')).toBeNull();
    expect(refs.viewPage(ADDRESS_A)).toBeNull();
    expect(refs.revalidateAddress(ADDRESS_A, uniquePage([]))).toBeNull();
  });
});

describe('MinimalCheckoutAddressReferences fail-closed registration', () => {
  it.each<[string, unknown]>([
    ['not_found', notFound()],
    ['ambiguous', ambiguous()],
    ['null context', null],
    ['array context', []],
    ['number context', 42],
    [
      'unknown status',
      {
        status: 'other',
        customer: null,
        addresses: [],
        nextAfterAddressId: null,
      },
    ],
    [
      'extra envelope key',
      { ...(uniquePage([address(ADDRESS_A)]) as object), extra: 1 },
    ],
    [
      'missing envelope key',
      { status: 'unique', customer: CUSTOMER, addresses: [address(ADDRESS_A)] },
    ],
    [
      'non-canonical version',
      uniquePage([address(ADDRESS_A, { version: 'nope' })]),
    ],
    [
      'non-canonical instant',
      uniquePage([address(ADDRESS_A, { version: '2026-06-22T10:30:00Z' })]),
    ],
    ['malformed id', uniquePage([address('not-a-uuid')])],
    ['v9 id', uniquePage([address(V9_UUID)])],
    ['duplicate id', uniquePage([address(ADDRESS_A), address(ADDRESS_A)])],
    [
      'cursor that is not the last id',
      {
        ...(uniquePage([address(ADDRESS_A), address(ADDRESS_B)]) as object),
        nextAfterAddressId: ADDRESS_A,
      },
    ],
  ])('rejects %s without registering it', (_label, context) => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    expect(refs.registerPage({ context })).toBeNull();
  });

  it.each<[string, unknown]>([
    ['limit zero', { limit: 0 }],
    ['limit above the maximum', { limit: 21 }],
    ['fractional limit', { limit: 1.5 }],
    ['string limit', { limit: '10' }],
    ['invalid cursor', { afterAddressId: 'not-a-uuid' }],
    ['unknown option', { unknownOption: true }],
    ['null query', null],
  ])('rejects %s instead of clamping it', (_label, query) => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    expect(
      refs.registerPage({ query, context: uniquePage([address(ADDRESS_A)]) }),
    ).toBeNull();
  });

  it('registers nothing without a non-blank trusted sender', () => {
    const refs = new MinimalCheckoutAddressReferences('');
    expect(
      refs.registerPage({ context: uniquePage([address(ADDRESS_A)]) }),
    ).toBeNull();
  });

  it('leaves prior bindings intact when a later registration is malformed', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const good = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    expect(refs.registerPage({ context: ambiguous() })).toBeNull();
    expect(
      refs.registerPage({ query: { limit: 21 }, context: uniquePage([]) }),
    ).toBeNull();
    expect(mustResolve(refs, good.addresses[0].reference).address.id).toBe(
      ADDRESS_A,
    );
    expect(mustPage(refs, good.pageReference).addresses).toHaveLength(1);
  });
});

describe('MinimalCheckoutAddressReferences bounded pagination', () => {
  it('offers an exact, limit-preserving next-page query', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      query: { limit: 5 },
      context: uniquePage([address(ADDRESS_A), address(ADDRESS_B)], {
        next: true,
      }),
    });
    expect(page.nextPageReference).not.toBeNull();
    const next = mustNext(refs, page.nextPageReference);
    expect(next.query).toEqual({ limit: 5, afterAddressId: ADDRESS_B });
    expect(next.customerId).toBe(CUSTOMER_ID);
  });

  it('offers no next-page reference for a single bounded page', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    expect(page.nextPageReference).toBeNull();
  });

  it('reuses the cursor without draining or clamping it', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const first = mustRegister(refs, {
      query: { limit: 5 },
      context: uniquePage([address(ADDRESS_A)], { next: true }),
    });
    const cursor = first.nextPageReference;
    const query = mustNext(refs, cursor).query;
    const second = mustRegister(refs, {
      query,
      cursorReference: cursor,
      context: uniquePage([address(ADDRESS_B)]),
    });
    const repeated = mustRegister(refs, {
      query,
      cursorReference: cursor,
      context: uniquePage([address(ADDRESS_B)]),
    });
    expect(second.pageReference).toBe(repeated.pageReference);
    const copy = mustNext(refs, cursor);
    copy.query.afterAddressId = 'mutated';
    expect(mustNext(refs, cursor).query).toEqual({
      limit: 5,
      afterAddressId: ADDRESS_A,
    });
  });

  it('registers a same-customer next page with the exact cursor', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const first = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)], { next: true }),
    });
    const cursor = first.nextPageReference;
    const second = mustRegister(refs, {
      query: mustNext(refs, cursor).query,
      cursorReference: cursor,
      context: uniquePage([address(ADDRESS_B)]),
    });
    expect(mustResolve(refs, second.addresses[0].reference).address.id).toBe(
      ADDRESS_B,
    );
  });

  it('rejects a cross-customer cursor registration without local change', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const first = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)], { next: true }),
    });
    const cursor = first.nextPageReference;
    const rejected = refs.registerPage({
      query: mustNext(refs, cursor).query,
      cursorReference: cursor,
      context: uniquePage([address(ADDRESS_B)], {
        customer: {
          customerId: OTHER_CUSTOMER_ID,
          firstName: 'Luis',
          lastName: null,
        },
      }),
    });
    expect(rejected).toBeNull();
    expect(mustResolve(refs, first.addresses[0].reference).address.id).toBe(
      ADDRESS_A,
    );
    expect(mustPage(refs, first.pageReference).addresses).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['a mismatched limit', { limit: 4 }],
    ['a mismatched cursor', { limit: 10, afterAddressId: NIL_UUID }],
    ['a missing query', undefined],
  ])('rejects %s for a cursor registration', (_label, query) => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const first = mustRegister(refs, {
      query: { limit: 10 },
      context: uniquePage([address(ADDRESS_A)], { next: true }),
    });
    const cursor = first.nextPageReference;
    expect(
      refs.registerPage({
        query,
        cursorReference: cursor,
        context: uniquePage([address(ADDRESS_B)]),
      }),
    ).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a non-string cursor', 12345],
    ['an empty cursor', ''],
    ['an unknown cursor', 'deadbeefdeadbeef'],
  ])('rejects %s', (_label, cursorReference) => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    expect(
      refs.registerPage({
        cursorReference: cursorReference as string,
        context: uniquePage([address(ADDRESS_A)]),
      }),
    ).toBeNull();
  });

  it('does not accept an address reference as a page cursor', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const first = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    expect(
      refs.registerPage({
        cursorReference: first.addresses[0].reference,
        context: uniquePage([address(ADDRESS_B)]),
      }),
    ).toBeNull();
  });
});

describe('MinimalCheckoutAddressReferences volatile bounded lifecycle', () => {
  it('rejects expired address, cursor and page references', () => {
    let now = 0;
    const refs = new MinimalCheckoutAddressReferences(SENDER, () => now);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)], { next: true }),
    });
    now = MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS;
    expect(refs.resolveAddress(page.addresses[0].reference)).toBeNull();
    expect(refs.resolveNextPage(page.nextPageReference)).toBeNull();
    expect(refs.viewPage(page.pageReference)).toBeNull();
  });

  it('accepts a fresh registration after expiry', () => {
    let now = 0;
    const refs = new MinimalCheckoutAddressReferences(SENDER, () => now);
    const first = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    now = MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS;
    const second = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    expect(second.addresses[0].reference).toBe(first.addresses[0].reference);
    expect(mustResolve(refs, second.addresses[0].reference).address.id).toBe(
      ADDRESS_A,
    );
  });

  it('retires the oldest references instead of permanently blocking forward paging', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const pages: MinimalCheckoutAddressPage[] = [];
    let previous = mustRegister(refs, {
      query: { limit: 10 },
      context: uniquePage(
        Array.from({ length: 10 }, (_, i) => address(uuidFor(i))),
        { next: true },
      ),
    });
    pages.push(previous);
    for (let index = 1; index < 5; index++) {
      const cursorReference = previous.nextPageReference;
      previous = mustRegister(refs, {
        query: { limit: 10, afterAddressId: uuidFor(index * 10 - 1) },
        cursorReference,
        context: uniquePage(
          Array.from({ length: 10 }, (_, i) =>
            address(uuidFor(index * 10 + i)),
          ),
          { next: true },
        ),
      });
      pages.push(previous);
    }
    const retained = pages.flatMap((page) => page.addresses);
    expect(retained).toHaveLength(MINIMAL_CHECKOUT_ADDRESS_REFERENCE_MAX);
    const oldestReference = pages[0].addresses[0].reference;
    expect(refs.resolveAddress(oldestReference)).not.toBeNull();
    const sixth = mustRegister(refs, {
      query: { limit: 10, afterAddressId: uuidFor(49) },
      cursorReference: pages[4].nextPageReference,
      context: uniquePage([address(uuidFor(50))]),
    });
    expect(refs.resolveAddress(sixth.addresses[0].reference)).not.toBeNull();
    expect(refs.resolveAddress(oldestReference)).toBeNull();
    expect(refs.viewPage(pages[0].pageReference)).toBeNull();
  });
});

describe('MinimalCheckoutAddressReferences sender isolation and restart', () => {
  it('never resolves another sender instance references', () => {
    const a = new MinimalCheckoutAddressReferences('sender-1');
    const b = new MinimalCheckoutAddressReferences('sender-2');
    const page = mustRegister(a, {
      context: uniquePage([address(ADDRESS_A)], { next: true }),
    });
    expect(b.resolveAddress(page.addresses[0].reference)).toBeNull();
    expect(b.viewPage(page.pageReference)).toBeNull();
    expect(b.resolveNextPage(page.nextPageReference)).toBeNull();
  });

  it('does not restore references in a fresh instance (restart invalidates)', () => {
    const a = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(a, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    const restarted = new MinimalCheckoutAddressReferences(SENDER);
    expect(restarted.resolveAddress(page.addresses[0].reference)).toBeNull();
    expect(restarted.viewPage(page.pageReference)).toBeNull();
  });
});

describe('MinimalCheckoutAddressReferences defensive copies and grounding', () => {
  it('returns detached resolutions of addresses and page queries', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      query: { limit: 5 },
      context: uniquePage([address(ADDRESS_A, { street: 'Av. Reforma 123' })]),
    });
    const reference = page.addresses[0].reference;
    const resolved = mustResolve(refs, reference);
    resolved.address.street = 'tampered';
    resolved.address.id = NIL_UUID;
    resolved.query.limit = 999;
    const again = mustResolve(refs, reference);
    expect(again.address.street).toBe('Av. Reforma 123');
    expect(again.address.id).toBe(ADDRESS_A);
    expect(again.query).toEqual({ limit: 5, afterAddressId: null });
  });

  it('does not expose mutable internals through the registration result', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A, { label: 'Casa' })]),
    });
    const offers = page.addresses as unknown as MinimalCheckoutAddressOffer[];
    (offers[0] as { label: string | null }).label = 'tampered';
    expect(mustPage(refs, page.pageReference).addresses[0].label).toBe('Casa');
  });

  it('views the offered choices with ordinal and verified unique labels', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([
        address(ADDRESS_A, { label: 'Casa' }),
        address(ADDRESS_B, { label: 'Oficina' }),
      ]),
    });
    expect(
      mustPage(refs, page.pageReference).addresses.map((offer) => ({
        ordinal: offer.ordinal,
        label: offer.label,
        uniqueLabel: offer.uniqueLabel,
        reference: offer.reference,
      })),
    ).toEqual([
      {
        ordinal: 1,
        label: 'Casa',
        uniqueLabel: 'Casa',
        reference: page.addresses[0].reference,
      },
      {
        ordinal: 2,
        label: 'Oficina',
        uniqueLabel: 'Oficina',
        reference: page.addresses[1].reference,
      },
    ]);
  });

  it('withholds a duplicated or absent label instead of choosing arbitrarily', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([
        address(ADDRESS_A, { label: 'Casa' }),
        address(ADDRESS_B, { label: 'Casa' }),
        address(ADDRESS_C, { label: null }),
      ]),
    });
    const view = mustPage(refs, page.pageReference);
    expect(view.addresses.map((offer) => offer.uniqueLabel)).toEqual([
      null,
      null,
      null,
    ]);
    expect(view.addresses.map((offer) => offer.label)).toEqual([
      'Casa',
      'Casa',
      null,
    ]);
    expect(view.addresses.map((offer) => offer.ordinal)).toEqual([1, 2, 3]);
  });
});

describe('MinimalCheckoutAddressReferences saved-address revalidation', () => {
  it('accepts a fresh page that still contains the exact id and version', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      query: { limit: 10 },
      context: uniquePage([address(ADDRESS_A)]),
    });
    const reference = page.addresses[0].reference;
    const revalidated = refs.revalidateAddress(
      reference,
      uniquePage([address(ADDRESS_A)]),
    );
    expect(revalidated?.reference).toBe(reference);
    expect(revalidated?.customerId).toBe(CUSTOMER_ID);
    expect(revalidated?.address.id).toBe(ADDRESS_A);
    expect(revalidated?.query).toEqual({ limit: 10, afterAddressId: null });
  });

  it('fails closed and invalidates a changed freshness version', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    const reference = page.addresses[0].reference;
    expect(
      refs.revalidateAddress(
        reference,
        uniquePage([address(ADDRESS_A, { version: VERSION_2 })]),
      ),
    ).toBeNull();
    expect(refs.resolveAddress(reference)).toBeNull();
  });

  it('fails closed and invalidates when the live page dropped the address', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    const reference = page.addresses[0].reference;
    expect(
      refs.revalidateAddress(reference, uniquePage([address(ADDRESS_B)])),
    ).toBeNull();
    expect(refs.resolveAddress(reference)).toBeNull();
  });

  it('treats byte-different identifiers as different addresses', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A_UPPER)]),
    });
    const reference = page.addresses[0].reference;
    expect(
      refs.revalidateAddress(reference, uniquePage([address(ADDRESS_A)])),
    ).toBeNull();
  });

  it('rejects another customer or a non-unique read without invalidating', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    const reference = page.addresses[0].reference;
    expect(
      refs.revalidateAddress(
        reference,
        uniquePage([address(ADDRESS_A)], {
          customer: {
            customerId: OTHER_CUSTOMER_ID,
            firstName: 'Luis',
            lastName: null,
          },
        }),
      ),
    ).toBeNull();
    expect(refs.revalidateAddress(reference, ambiguous())).toBeNull();
    expect(refs.revalidateAddress(reference, null)).toBeNull();
    expect(refs.resolveAddress(reference)).not.toBeNull();
  });

  it('returns detached revalidated addresses', () => {
    const refs = new MinimalCheckoutAddressReferences(SENDER);
    const page = mustRegister(refs, {
      context: uniquePage([address(ADDRESS_A)]),
    });
    const reference = page.addresses[0].reference;
    const revalidated = refs.revalidateAddress(
      reference,
      uniquePage([address(ADDRESS_A)]),
    );
    if (revalidated === null) throw new Error('expected revalidation');
    revalidated.address.street = 'tampered';
    const again = mustResolve(refs, reference);
    expect(again.address.street).toBe('Av. Reforma 123');
  });
});
