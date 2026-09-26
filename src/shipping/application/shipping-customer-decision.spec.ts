/**
 * SCA-1b: focused contract tests for the pure Spanish disclosure renderer and
 * strict raw-text decision parser. No store, router, provider, model, gate,
 * backend or environment access.
 */
import { normalizeShippingCustomerOffer } from './shipping-customer-acceptance';
import {
  parseShippingCustomerDecision as parse,
  renderShippingCustomerOffer as render,
} from './shipping-customer-decision';

const REQ = 'abcdef123456',
  DRAFT = '2026-06-23T12:00:00.000Z',
  OFFERED = '2026-06-23T12:00:05.000Z',
  EXPIRES = '2026-06-23T12:30:05.000Z',
  OUT_ID = 'provider-secret-123',
  INT32_MAX = 2_147_483_647;

const offerOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  offeredAt: OFFERED,
  expiresAt: EXPIRES,
  merchandiseCents: 100_000,
  chargeCents: 12_900,
  expectedTotalCents: 112_900,
  providerMessageId: OUT_ID,
  ...overrides,
});

describe('renderShippingCustomerOffer', () => {
  it('renders distinct merchandise, freight and total MXN lines', () => {
    const text = render(offerOf())!;
    expect(text).toContain('Mercancía: $1,000.00 MXN');
    expect(text).toContain('Envío: $129.00 MXN');
    expect(text).toContain('Total: $1,129.00 MXN');
  });

  it('renders zero merchandise with positive freight honestly', () => {
    const text = render(
      offerOf({
        merchandiseCents: 0,
        chargeCents: 4_999,
        expectedTotalCents: 4_999,
      }),
    )!;
    expect(text).toContain('Mercancía: $0.00 MXN');
    expect(text).toContain('Envío: $49.99 MXN');
    expect(text).toContain('Total: $49.99 MXN');
  });

  it('groups thousands and preserves cent precision', () => {
    const text = render(
      offerOf({
        merchandiseCents: 1_234_567,
        chargeCents: 100,
        expectedTotalCents: 1_234_667,
      }),
    )!;
    expect(text).toContain('Mercancía: $12,345.67 MXN');
    expect(text).toContain('Envío: $1.00 MXN');
    expect(text).toContain('Total: $12,346.67 MXN');
  });

  it('renders the signed int32 cents bound without overflow formatting', () => {
    const text = render(
      offerOf({
        merchandiseCents: INT32_MAX - 1,
        chargeCents: 1,
        expectedTotalCents: INT32_MAX,
      }),
    )!;
    expect(text).toContain('Total: $21,474,836.47 MXN');
    expect(text).toContain('Mercancía: $21,474,836.46 MXN');
    expect(text).toContain('Envío: $0.01 MXN');
  });

  it('requests an explicit SÍ or NO and states the price will be verified', () => {
    const text = render(offerOf())!;
    expect(text).toContain('"SÍ"');
    expect(text).toContain('"NO"');
    expect(text).toContain(
      'Verificaremos el precio antes de registrar tu pedido. Si cambia, te mostraremos el nuevo total para que lo confirmes otra vez.',
    );
  });

  it('avoids implementation jargon in customer-facing text', () => {
    const text = render(offerOf())!;
    expect(text).not.toMatch(/backend|api|token|json|provider|cents|endpoint/i);
  });

  it('never leaks the provider message id or claims an order was placed', () => {
    const text = render(offerOf())!;
    expect(text).not.toContain(OUT_ID);
    expect(text).not.toMatch(/svc_/);
    expect(text).not.toMatch(/pedido (confirmado|realizado|listo)/i);
    expect(text).not.toMatch(/orden (confirmada|realizada)/i);
  });

  it('is deterministic for raw and pre-normalized offers', () => {
    const raw = offerOf();
    expect(render(raw)).toBe(render(raw));
    expect(render(raw)).toBe(render(normalizeShippingCustomerOffer(raw)));
  });

  it.each<[string, unknown]>([
    ['a null offer', null],
    ['a malformed offer', offerOf({ expectedTotalCents: 112_901 })],
    [
      'a non-positive freight',
      offerOf({ chargeCents: 0, expectedTotalCents: 100_000 }),
    ],
    ['a non-advancing expiry window', offerOf({ expiresAt: OFFERED })],
    ['a non-canonical expiry', offerOf({ expiresAt: '2026-06-23T12:30:05Z' })],
    ['a missing key', { ...offerOf(), providerMessageId: undefined }],
  ])('fails closed on %s', (_label, raw) => {
    expect(render(raw)).toBeNull();
  });
});

describe('parseShippingCustomerDecision', () => {
  it.each([
    'SI',
    'SÍ',
    'si',
    'sí',
    'Sí',
    ' SI ',
    '\tSÍ\t',
    'SI.',
    'SÍ.',
    ' sí. ',
  ])('accepts a whole affirmative: %j', (raw) => {
    expect(parse(raw)).toBe('accept');
  });

  it.each(['NO', 'no', 'No', 'NO.', 'no.', ' NO '])(
    'declines a whole rejection: %j',
    (raw) => {
      expect(parse(raw)).toBe('decline');
    },
  );

  it.each<[string, unknown]>([
    ['empty', ''],
    ['spaces only', '   '],
    ['bare letter', 'S'],
    ['concatenated', 'SÍSÍ'],
    ['extra word', 'SI por favor'],
    ['two answers', 'SI NO'],
    ['trailing amount', 'SI 100'],
    ['comma', 'SÍ,'],
    ['emoji suffix', 'SÍ 🙂'],
    ['emoji only', '👍'],
    ['period only', '.'],
    ['double period', 'SI..'],
    ['space before period', 'SI .'],
    ['trailing newline', 'SI\n'],
    ['leading newline', '\nNO'],
    ['newline between', 'SI\nNO'],
    ['grave accent', 'SÌ'],
    ['circumflex', 'SÎ'],
    ['combining acute', 'SI\u0301'],
    ['english yes', 'yes'],
    ['spanish word', 'acepto'],
    ['number', 123],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['plain object', {}],
    ['array', ['SI']],
  ])('rejects %s with null', (_label, raw) => {
    expect(parse(raw)).toBeNull();
  });

  it('never throws and returns null on hostile or unknown inputs', () => {
    const symbolRaw = Symbol('SI');
    const hostile: unknown[] = [
      symbolRaw,
      BigInt(1),
      Object('SI'),
      new Proxy({}, {}),
      { toString: () => 'SI' },
      [['SI']],
    ];
    for (const raw of hostile) {
      expect(() => parse(raw)).not.toThrow();
      expect(parse(raw)).toBeNull();
    }
  });
});
