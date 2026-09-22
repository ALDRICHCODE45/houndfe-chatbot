import type { ShippingQuoteRequest } from '../domain/shipping-quote.request';
import type { SkydropxQuotationPayload } from './skydropx-quotation.client';
import {
  SkydropxShippingQuoteProvider,
  type SkydropxQuotationClientDeps,
} from './skydropx-shipping-quote.provider';

type Rec = Record<string, unknown>;
const SECRET = 'SECRET_SENTINEL_7f';
const QUOTE = 'quote-1';
const OTHER = 'quote-2';
const BASE = {
  countryCode: 'MX',
  postalCode: '64000',
  state: 'Nuevo León',
  municipality: 'Monterrey',
  neighborhood: 'Centro',
};
const REQ_A: ShippingQuoteRequest = {
  origin: {
    ...BASE,
    postalCode: '06000',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
  },
  destination: BASE,
  parcels: [{ lengthCm: 20, widthCm: 15, heightCm: 10, weightGrams: 2500 }],
};
const PAYLOAD_A = JSON.parse(
  '{"quotation":{"address_from":{"country_code":"MX","postal_code":"06000","area_level1":"Ciudad de México","area_level2":"Cuauhtémoc","area_level3":"Centro"},"address_to":{"country_code":"MX","postal_code":"64000","area_level1":"Nuevo León","area_level2":"Monterrey","area_level3":"Centro"},"parcels":[{"length":20,"width":15,"height":10,"weight":2.5}]}}',
) as SkydropxQuotationPayload;
const raw = (over: Rec = {}): Rec => ({
  id: 'rate-1',
  success: true,
  provider_display_name: 'Estafeta',
  provider_service_name: 'Día Siguiente',
  currency_code: 'MXN',
  total: '129.00',
  days: 1,
  ...over,
});
const rate = {
  rateId: 'rate-1',
  carrierName: 'Estafeta',
  serviceName: 'Día Siguiente',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 1,
  validUntil: null,
};
const quoted = (quoteId: string = QUOTE, rates: unknown[] = [rate]) => ({
  kind: 'quoted',
  quoteId,
  rates,
  expiresAt: null,
});
const err = (error: unknown) => ({ kind: 'error', error });
const malformed = err({ kind: 'malformed_response' });
const noRates = err({ kind: 'no_rates' });
const upstream = err({ kind: 'upstream_unavailable', httpStatus: null });
const invalid = err({ kind: 'invalid_request', field: 'unknown' });
const created = (quotationId: string = QUOTE) => ({
  kind: 'created',
  quotationId,
});
const completed = (
  quotationId: unknown = QUOTE,
  providerRates: unknown = [raw()],
) => ({ kind: 'completed', quotationId, providerRates });
const ERRORS = [
  { kind: 'auth_failed' },
  { kind: 'invalid_request', field: 'parcels' },
  { kind: 'rate_limited', retryAfterSeconds: 12 },
  { kind: 'upstream_unavailable', httpStatus: 503 },
  { kind: 'timeout' },
  { kind: 'malformed_response' },
  { kind: 'no_rates' },
  { kind: 'provider_disabled' },
];
const getter = Object.defineProperty({}, 'kind', {
  get: () => {
    throw new Error(SECRET);
  },
});
const protoProxy = new Proxy(
  {},
  {
    getPrototypeOf() {
      throw new Error(SECRET);
    },
  },
);
const make = (
  create: (payload: unknown) => unknown,
  poll: (id: unknown) => unknown = () => undefined,
) => {
  const calls = { create: [] as unknown[], poll: [] as unknown[] };
  const order: string[] = [];
  const run = (name: 'create' | 'poll', arg: unknown, fn: () => unknown) => {
    calls[name].push(arg);
    order.push(name);
    return fn();
  };
  const deps = {
    create: (p: unknown) => run('create', p, () => create(p)),
    poll: (id: unknown) => run('poll', id, () => poll(id)),
  } as unknown as SkydropxQuotationClientDeps;
  return { subject: new SkydropxShippingQuoteProvider(deps), calls, order };
};

describe('SkydropxShippingQuoteProvider', () => {
  it('runs the canonical create-then-poll path to a quoted result', async () => {
    const { subject, calls, order } = make(
      () => created(),
      () => completed(),
    );
    expect(await subject.quote(REQ_A)).toEqual(quoted());
    expect(calls.create).toEqual([PAYLOAD_A]);
    expect(calls.poll).toEqual([QUOTE]);
    expect(order).toEqual(['create', 'poll']);
  });

  it('returns invalid_request with zero calls when mapping fails', async () => {
    const { subject, calls } = make(
      () => created(),
      () => completed(),
    );
    await expect(subject.quote({} as ShippingQuoteRequest)).resolves.toEqual(
      invalid,
    );
    expect(calls.create).toEqual([]);
    expect(calls.poll).toEqual([]);
  });

  it('normalizes every finite create and poll error', async () => {
    for (const error of ERRORS) {
      const create = make(
        () => err(error),
        () => completed(),
      );
      await expect(create.subject.quote(REQ_A)).resolves.toEqual(err(error));
      expect(create.calls.create).toEqual([PAYLOAD_A]);
      expect(create.calls.poll).toEqual([]);
      const poll = make(
        () => created(),
        () => err(error),
      );
      await expect(poll.subject.quote(REQ_A)).resolves.toEqual(err(error));
      expect(poll.calls.poll).toEqual([QUOTE]);
    }
    const leak = make(
      () => err({ kind: 'provider_leak', token: SECRET, body: SECRET }),
      () => completed(),
    );
    const out = await leak.subject.quote(REQ_A);
    expect(out).toEqual(malformed);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('maps rejected and synchronously throwing calls to upstream', async () => {
    const boom = () => {
      throw new Error(SECRET);
    };
    const reject = () => Promise.reject(new Error(SECRET));
    for (const { subject } of [
      make(reject, () => completed()),
      make(boom, () => completed()),
      make(() => created(), reject),
      make(() => created(), boom),
    ]) {
      const out = await subject.quote(REQ_A);
      expect(out).toEqual(upstream);
    }
  });

  it('maps malformed or hostile client outcomes to malformed_response', async () => {
    for (const value of [
      null,
      { kind: 'unknown' },
      { kind: 'created', quotationId: 'bad id' },
      getter,
      protoProxy,
    ]) {
      const { subject, calls } = make(
        () => value,
        () => completed(),
      );
      expect(await subject.quote(REQ_A)).toEqual(malformed);
      expect(calls.poll).toEqual([]);
    }
    for (const value of [
      null,
      { kind: 'unknown' },
      { kind: 'completed', quotationId: QUOTE },
      getter,
      protoProxy,
    ]) {
      const { subject, calls } = make(
        () => created(),
        () => value,
      );
      const out = await subject.quote(REQ_A);
      expect(out).toEqual(malformed);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(calls.poll).toEqual([QUOTE]);
    }
  });

  it('returns no_rates for empty/invalid rates and filters survivors', async () => {
    await expect(
      make(
        () => created(),
        () => completed(QUOTE, []),
      ).subject.quote(REQ_A),
    ).resolves.toEqual(noRates);
    const dead = raw({ success: false });
    await expect(
      make(
        () => created(),
        () => completed(QUOTE, [dead, raw({ currency_code: 'USD' })]),
      ).subject.quote(REQ_A),
    ).resolves.toEqual(noRates);
    await expect(
      make(
        () => created(),
        () => completed(QUOTE, [raw(), dead, raw({ id: 'rate-2' })]),
      ).subject.quote(REQ_A),
    ).resolves.toEqual(quoted(QUOTE, [rate, { ...rate, rateId: 'rate-2' }]));
  });

  it('rejects a poll id that does not match the created id', async () => {
    const { subject } = make(
      () => created(),
      () => completed(OTHER),
    );
    await expect(subject.quote(REQ_A)).resolves.toEqual(malformed);
  });

  it('calls each dependency once in order without leaking or retaining raws', async () => {
    const element = raw({ token: SECRET });
    const rates = [element];
    const { subject, calls, order } = make(
      () => ({ kind: 'created', quotationId: QUOTE, token: SECRET }),
      () => ({
        kind: 'completed',
        quotationId: QUOTE,
        providerRates: rates,
        token: SECRET,
      }),
    );
    const out = await subject.quote(REQ_A);
    expect(order).toEqual(['create', 'poll']);
    expect(calls.poll).toEqual([QUOTE]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const snapshot = JSON.parse(JSON.stringify(out)) as unknown;
    element.total = '999.99';
    element.id = 'mutated';
    rates.push(raw({ id: 'injected' }));
    expect(JSON.parse(JSON.stringify(out))).toEqual(snapshot);
    expect(out).toEqual(quoted());
  });

  it('keeps concurrent calls independent', async () => {
    const { subject } = make(
      (payload) => ({
        kind: 'created',
        quotationId: (
          payload as { quotation: { address_from: { postal_code: string } } }
        ).quotation.address_from.postal_code,
      }),
      (id) => completed(id, [raw({ id: `rate-${String(id)}` })]),
    );
    const reqB: ShippingQuoteRequest = {
      ...REQ_A,
      origin: {
        ...REQ_A.origin,
        postalCode: '44100',
        state: 'Jalisco',
        municipality: 'Guadalajara',
      },
    };
    const [a, b] = await Promise.all([
      subject.quote(REQ_A),
      subject.quote(reqB),
    ]);
    expect(a).toEqual(quoted('06000', [{ ...rate, rateId: 'rate-06000' }]));
    expect(b).toEqual(quoted('44100', [{ ...rate, rateId: 'rate-44100' }]));
  });
});
