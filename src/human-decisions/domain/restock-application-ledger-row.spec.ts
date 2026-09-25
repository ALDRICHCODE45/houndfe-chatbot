import { deriveRestockAttemptId } from './restock-attempt-identity';
import { normalizeRestockApplicationLedgerRow } from './restock-application-ledger-row';

const sourceRequestId = '11111111-1111-4111-8111-111111111111';
const decisionId = '22222222-2222-4222-8222-222222222222';
const sendToken = '33333333-3333-4333-8333-333333333333';
const resolvedAt = '2026-09-25T10:00:00.000Z';
const applyBefore = '2026-09-25T11:00:00.000Z';
const base = {
  senderId: 'customer',
  branchId: 'branch-123',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId),
  resolvedAt,
  applyBefore,
};
const started = { sendToken, attemptedAt: resolvedAt };
const accepted = {
  ...started,
  providerMessageId: 'provider-123',
  providerAcceptedObservedAt: '2026-09-25T10:30:00.000Z',
};
const rows: Record<string, unknown>[] = [
  { ...base, state: 'PENDING_DELIVERY' },
  { ...base, state: 'SEND_STARTED', ...started },
  { ...base, state: 'PROVIDER_ACCEPTED', ...accepted },
  {
    ...base,
    state: 'PROVIDER_ACCEPTED_LATE',
    ...accepted,
    providerAcceptedObservedAt: applyBefore,
  },
  { ...base, state: 'STALE', staleObservedAt: applyBefore },
];
const normalize = normalizeRestockApplicationLedgerRow;

describe('normalizeRestockApplicationLedgerRow', () => {
  it.each(rows.map((row) => [row.state, row]))(
    'accepts and detaches frozen %s',
    (_state, input) => {
      const row = input;
      const result = normalize(row);
      expect(result).toEqual(row);
      expect(result).not.toBe(row);
      expect(Object.isFrozen(result)).toBe(true);
      const copy = { ...row };
      const detached = normalize(copy);
      copy.branchId = 'changed';
      expect(detached?.branchId).toBe('branch-123');
    },
  );
  it('preserves padded opaque branch and provider identity bytes', () => {
    const row = {
      ...rows[2],
      branchId: ' branch-123 ',
      providerMessageId: ' p ',
    };
    expect(normalize(row)).toEqual(row);
  });
  it('accepts null-prototype plain data', () => {
    expect(normalize(Object.assign(Object.create(null), rows[0]))).toEqual(
      rows[0],
    );
  });
  it('accepts the last millisecond before the deadline', () => {
    expect(
      normalize({
        ...rows[2],
        attemptedAt: '2026-09-25T10:59:59.999Z',
        providerAcceptedObservedAt: '2026-09-25T10:59:59.999Z',
      }),
    ).not.toBeNull();
  });
  it.each([
    ['wrong attempt', { attemptId: sendToken }],
    ['noncanonical attempt', { attemptId: base.attemptId?.toUpperCase() }],
    ['changed source', { sourceRequestId: sendToken }],
    ['changed decision', { decisionId: sendToken }],
    ['bad source UUID', { sourceRequestId: 'bad' }],
    ['bad decision UUID', { decisionId: null }],
    ['wrong version', { resolutionVersion: 1 }],
    ['string version', { resolutionVersion: '2' }],
    ['blank sender', { senderId: ' ' }],
    ['padded sender', { senderId: ' customer' }],
    ['blank branch', { branchId: ' ' }],
    ['control branch', { branchId: 'branch\u0085' }],
    ['extra key', { extra: null }],
    ['unknown delivery', { state: 'DELIVERY_UNKNOWN' }],
    ['unknown state', { state: 'OTHER' }],
    ['pending token', { sendToken }],
    ['pending null evidence', { attemptedAt: null }],
    ['short deadline', { applyBefore: '2026-09-25T10:59:59.999Z' }],
    ['long deadline', { applyBefore: '2026-09-25T11:00:00.001Z' }],
    ['offset time', { resolvedAt: '2026-09-25T10:00:00.000+00:00' }],
    ['date only', { resolvedAt: '2026-09-25' }],
    ['missing milliseconds', { resolvedAt: '2026-09-25T10:00:00Z' }],
    ['impossible date', { resolvedAt: '2026-02-30T10:00:00.000Z' }],
    ['invalid deadline', { applyBefore: 'bad' }],
  ])('rejects %s', (_name, patch) => {
    expect(normalize({ ...rows[0], ...patch })).toBeNull();
  });
  it.each([
    ['bad token', 1, { sendToken: 'bad' }],
    ['token equals attempt', 1, { sendToken: base.attemptId }],
    ['case alias token', 1, { sendToken: base.attemptId?.toUpperCase() }],
    ['before resolution', 1, { attemptedAt: '2026-09-25T09:59:59.999Z' }],
    ['at deadline', 1, { attemptedAt: applyBefore }],
    ['invalid start', 1, { attemptedAt: 'bad' }],
    ['missing provider ID', 2, { providerMessageId: undefined }],
    ['blank provider ID', 2, { providerMessageId: ' ' }],
    ['control provider ID', 2, { providerMessageId: 'p\u007f' }],
    [
      'acceptance before start',
      2,
      { providerAcceptedObservedAt: '2026-09-25T09:59:59.999Z' },
    ],
    ['accepted at deadline', 2, { providerAcceptedObservedAt: applyBefore }],
    ['invalid acceptance', 2, { providerAcceptedObservedAt: 'bad' }],
    ['late before deadline', 3, { providerAcceptedObservedAt: resolvedAt }],
    ['stale before deadline', 4, { staleObservedAt: resolvedAt }],
    ['invalid stale time', 4, { staleObservedAt: 'bad' }],
    ['stale token', 4, { sendToken }],
    ['stale null token', 4, { sendToken: null }],
    ['stale start', 4, { attemptedAt: resolvedAt }],
    ['stale provider', 4, { providerMessageId: null }],
    ['stale observation', 4, { providerAcceptedObservedAt: null }],
  ] as const)('rejects %s', (_name, index, patch) => {
    expect(normalize({ ...rows[index], ...patch })).toBeNull();
  });
  it.each(Object.keys(rows[2]))('rejects missing required %s', (key) => {
    const row = { ...rows[2] };
    delete row[key];
    expect(normalize(row)).toBeNull();
  });
  it.each([
    ['null', (): null => null],
    ['array', () => []],
    ['primitive', (): string => 'row'],
    ['class', () => Object.assign(new (class Row {})(), rows[0])],
    ['inherited', (): unknown => Object.create(rows[0])],
    ['symbol', () => ({ ...rows[0], [Symbol('extra')]: true })],
    [
      'hidden extra',
      () => Object.defineProperty({ ...rows[0] }, 'extra', { value: 1 }),
    ],
    [
      'accessor',
      () =>
        Object.defineProperty({ ...rows[0] }, 'state', {
          get: () => 'PENDING_DELIVERY',
        }),
    ],
    [
      'throwing proxy',
      () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('trap');
            },
          },
        ),
    ],
    [
      'descriptor mismatch',
      () =>
        new Proxy(rows[0], {
          get: (row, key): unknown =>
            key === 'branchId' ? 'other' : row[key as string],
        }),
    ],
    [
      'revoked proxy',
      () => {
        const proxy = Proxy.revocable({}, {});
        proxy.revoke();
        return proxy.proxy;
      },
    ],
  ] as const)('fails closed for %s', (_name, make) => {
    expect(normalize(make())).toBeNull();
  });
});
