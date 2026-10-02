import { classifyExpirationPostTransition as classify } from './expiration-post-ledger';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const senderId = 'whatsapp:+5215500000001';
const row = (status = 'RESERVED', overrides: Record<string, unknown> = {}) => ({
  type: 'EXPIRATION',
  status,
  senderId,
  sourceRequestId: SOURCE,
  backendDecisionId: status === 'RECEIPT_RECORDED' ? ID : null,
  ...overrides,
});
const input = (
  existing: unknown = row(),
  step: unknown = { kind: 'begin_post' },
) => ({
  senderId,
  sourceRequestId: SOURCE,
  existing,
  step,
});
const receipt = (backendDecisionId = ID) => ({
  kind: 'record_receipt',
  backendDecisionId,
});

describe('classifyExpirationPostTransition (pure, not a persisted claim)', () => {
  it.each([
    ['RESERVED', { action: 'authorize_post' }],
    ['POST_IN_FLIGHT', { action: 'hold', reason: 'post_in_flight' }],
    ['UNKNOWN', { action: 'hold', reason: 'unknown_state' }],
    [
      'RECEIPT_RECORDED',
      { action: 'historical_receipt', backendDecisionId: ID },
    ],
  ])('begin_post from %s', (status, expected) => {
    expect(classify(input(row(status)))).toEqual(expected);
  });

  it.each([
    ['RESERVED', { action: 'blocked', reason: 'not_in_flight' }],
    ['POST_IN_FLIGHT', { action: 'record_receipt', backendDecisionId: ID }],
    ['UNKNOWN', { action: 'blocked', reason: 'unknown_state' }],
    ['RECEIPT_RECORDED', { action: 'replay_receipt', backendDecisionId: ID }],
  ])('record_receipt from %s', (status, expected) => {
    expect(classify(input(row(status), receipt()))).toEqual(expected);
  });

  it.each([
    ['RESERVED', { action: 'mark_unknown', reason: 'pre_post' }],
    ['POST_IN_FLIGHT', { action: 'mark_unknown', reason: 'ambiguous_post' }],
    ['UNKNOWN', { action: 'hold', reason: 'already_unknown' }],
    ['RECEIPT_RECORDED', { action: 'blocked', reason: 'receipt_recorded' }],
  ])('mark_unknown from %s', (status, expected) => {
    expect(classify(input(row(status), { kind: 'mark_unknown' }))).toEqual(
      expected,
    );
  });

  it('conflicts rather than replacing a historical receipt', () => {
    expect(classify(input(row('RECEIPT_RECORDED'), receipt(OTHER)))).toEqual({
      action: 'conflict',
      storedBackendDecisionId: ID,
    });
  });

  it.each([
    { senderId: '' },
    { senderId: '   ' },
    { sourceRequestId: null },
    { sourceRequestId: '00000000-0000-0000-0000-000000000000' },
    { sourceRequestId: ` ${SOURCE}` },
    { sourceRequestId: 'not-a-uuid' },
  ])('blocks malformed request identity %j', (patch) => {
    expect(classify({ ...input(), ...patch }).action).toBe('blocked');
  });

  it('rejects outer and step accessors and throwing traps without leaking errors', () => {
    const getter = jest.fn(() => 'begin_post');
    const step = Object.defineProperty({}, 'kind', { get: getter });
    const outer = Object.defineProperty(input(), 'senderId', { get: getter });
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    for (const candidate of [
      outer,
      hostile,
      input(row(), step),
      input(row(), hostile),
    ]) {
      expect(() => classify(candidate)).not.toThrow();
      expect(classify(candidate).action).toBe('blocked');
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['absent', 'unknown'])('blocks %s readings', (existing) => {
    expect(classify(input(existing)).action).toBe('blocked');
  });

  it.each([
    { type: 'RESTOCK' },
    { status: null },
    { status: 'CLOSED' },
    { backendDecisionId: ID },
    { senderId: 'different' },
    { sourceRequestId: OTHER },
    { extra: true },
  ])('rejects invalid or mismatched rows %j', (patch) => {
    expect(classify(input(row('RESERVED', patch))).action).toBe('blocked');
  });

  it.each([
    null,
    undefined,
    '',
    '00000000-0000-0000-0000-000000000000',
    'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
    ID.toUpperCase(),
    ` ${ID}`,
  ])('rejects noncanonical backend id %s', (id) => {
    expect(
      classify(
        input(row('POST_IN_FLIGHT'), {
          kind: 'record_receipt',
          backendDecisionId: id,
        }),
      ).action,
    ).toBe('blocked');
    expect(
      classify(input(row('RECEIPT_RECORDED', { backendDecisionId: id })))
        .action,
    ).toBe('blocked');
  });

  it('preserves valid mixed-case source bytes and requires exact binding', () => {
    const source = ID.toUpperCase();
    const request = {
      ...input(row('RESERVED', { sourceRequestId: source })),
      sourceRequestId: source,
    };
    expect(classify(request)).toEqual({ action: 'authorize_post' });
    expect(classify({ ...request, sourceRequestId: ID }).action).toBe(
      'blocked',
    );
  });

  it.each([
    {},
    { kind: 'retry' },
    { kind: 'begin_post', backendDecisionId: ID },
    { ...receipt(), extra: true },
    { kind: 'mark_unknown', extra: undefined },
  ])('rejects malformed steps %j', (step) => {
    expect(classify(input(row(), step)).action).toBe('blocked');
  });

  it('rejects missing, inherited, symbol and accessor fields without invoking getters', () => {
    const getter = jest.fn(() => 'RESERVED');
    const accessor = { ...row() };
    Object.defineProperty(accessor, 'status', { get: getter });
    const missing = { ...row() } as Record<string, unknown>;
    delete missing.backendDecisionId;
    for (const existing of [
      missing,
      Object.create(row()),
      accessor,
      { ...row(), [Symbol('extra')]: true },
    ])
      expect(classify(input(existing)).action).toBe('blocked');
    expect(getter).not.toHaveBeenCalled();
    expect(classify({ ...input(), [Symbol('extra')]: true }).action).toBe(
      'blocked',
    );
    expect(
      classify(input(row(), { ...receipt(), [Symbol('extra')]: true })).action,
    ).toBe('blocked');
  });

  it('blocks hostile proxies and descriptor/read disagreement', () => {
    const revoked = Proxy.revocable(row(), {});
    revoked.revoke();
    const rotating = new Proxy(row(), {
      get: (target, key): unknown =>
        key === 'status' ? 'POST_IN_FLIGHT' : Reflect.get(target, key),
    });
    for (const existing of [revoked.proxy, rotating]) {
      expect(() => classify(input(existing))).not.toThrow();
      expect(classify(input(existing)).action).toBe('blocked');
    }
  });

  it('does not mutate frozen input or turn a pure decision into CAS authority', () => {
    const request = Object.freeze(
      input(Object.freeze(row()), Object.freeze({ kind: 'begin_post' })),
    );
    expect(classify(request)).toEqual({ action: 'authorize_post' });
    expect(classify(request)).toEqual({ action: 'authorize_post' });
    expect(request.existing).toEqual(row());
  });
});
