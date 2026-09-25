import {
  classifyPostTransition,
  type RestockPostBlockedReason,
  type RestockPostClassifyInput,
  type RestockPostDecision,
  type RestockPostStep,
} from './restock-post-ledger';

const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';
const DECISION = '33333333-3333-4333-8333-333333333333';

const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'RESERVED',
  senderId: SENDER,
  sourceRequestId: SOURCE,
  backendDecisionId: null,
  ...o,
});
const recorded = (id: unknown): Record<string, unknown> =>
  row({ status: 'RECEIPT_RECORDED', backendDecisionId: id });
const inFlight = row({ status: 'POST_IN_FLIGHT' });
const BEGIN: RestockPostStep = { kind: 'begin_post' };
const receipt = (backendDecisionId: unknown): Record<string, unknown> => ({
  kind: 'record_receipt',
  backendDecisionId,
});
const B = (reason: RestockPostBlockedReason): RestockPostDecision => ({
  action: 'blocked',
  reason,
});
const run = (existing: unknown, step: unknown): RestockPostDecision =>
  classifyPostTransition({
    senderId: SENDER,
    sourceRequestId: SOURCE,
    existing,
    step,
  } as RestockPostClassifyInput);

describe('classifyPostTransition adversarial', () => {
  it.each(['RESERVED', 'POST_IN_FLIGHT', 'UNKNOWN'])(
    'rejects a %s row that leaks a backend id',
    (status) => {
      const existing = row({ status, backendDecisionId: DECISION });
      expect(run(existing, BEGIN)).toEqual(B('malformed_row'));
    },
  );

  it('rejects a malformed recorded id on the existing row', () => {
    expect(run(recorded('nope'), BEGIN)).toEqual(B('malformed_row'));
    expect(run(recorded(null), BEGIN)).toEqual(B('malformed_row'));
  });

  it('rejects an unknown state value on the existing row', () => {
    expect(run(row({ status: 'BAD' }), BEGIN)).toEqual(B('malformed_row'));
  });

  it('rejects a non-UUID backend id on the record step', () => {
    const step = receipt('nope');
    expect(run(inFlight, step)).toEqual(B('invalid_backend_decision_id'));
  });

  it('rejects absent, unknown-row and mismatched targets', () => {
    const mismatch = B('sender_mismatch');
    expect(run('absent', BEGIN)).toEqual(B('missing_row'));
    expect(run('unknown', BEGIN)).toEqual(B('unknown_row'));
    expect(run(row({ senderId: 'other' }), BEGIN)).toEqual(mismatch);
    expect(run(row({ sourceRequestId: OTHER_SOURCE }), BEGIN)).toEqual(
      mismatch,
    );
  });

  it('requires an exact plain own-data row snapshot', () => {
    const missing = row();
    delete missing.backendDecisionId;
    const inherited = Object.assign(
      Object.create({ status: 'RESERVED' }) as object,
      { senderId: SENDER, sourceRequestId: SOURCE, backendDecisionId: null },
    ) as unknown;
    const accessor = row();
    Object.defineProperty(accessor, 'status', { get: () => 'RESERVED' });
    const cases: unknown[] = [
      row({ backendDecisionId: undefined }),
      missing,
      row({ extra: 1 }),
      inherited,
      accessor,
    ];
    for (const existing of cases) {
      expect(run(existing, BEGIN)).toEqual(B('malformed_row'));
    }
  });

  it('rejects a hostile top-level input or step', () => {
    const base: Record<string, unknown> = {
      senderId: SENDER,
      sourceRequestId: SOURCE,
      existing: 'absent',
      step: BEGIN,
    };
    const accessorInput = { ...base };
    Object.defineProperty(accessorInput, 'senderId', { get: () => SENDER });
    const changingStep = new Proxy(
      { kind: 'begin_post' },
      { get: (_t, prop) => (prop === 'kind' ? 'mark_unknown' : undefined) },
    );
    const accessorStep = { kind: 'begin_post' };
    Object.defineProperty(accessorStep, 'kind', { get: () => 'begin_post' });
    const cases: unknown[] = [
      accessorInput,
      { ...base, extra: 1 },
      { ...base, step: changingStep },
      { ...base, step: accessorStep },
      { ...base, step: { kind: 'explode' } },
      { ...base, step: { kind: 'record_receipt' } },
    ];
    for (const input of cases) {
      const typed = input as RestockPostClassifyInput;
      expect(classifyPostTransition(typed)).toEqual(B('malformed_input'));
    }
  });

  it('does not reread untrusted input after snapshotting', () => {
    let reads = 0;
    const probe = new Proxy(
      {
        senderId: SENDER,
        sourceRequestId: SOURCE,
        existing: row(),
        step: BEGIN,
      },
      {
        get: (target, prop) => {
          reads += 1;
          if (reads > 4) throw new Error('reread');
          return Reflect.get(target, prop) as unknown;
        },
      },
    );
    expect(classifyPostTransition(probe as never)).toEqual({
      action: 'authorize_post',
    });
    expect(reads).toBe(4);
  });

  it('keeps a valid recorded id as a historical poll key only', () => {
    expect(run(recorded(DECISION), BEGIN)).toEqual({
      action: 'historical_receipt',
      backendDecisionId: DECISION,
    });
    expect(run(inFlight, receipt(OTHER_SOURCE))).toEqual({
      action: 'record_receipt',
      backendDecisionId: OTHER_SOURCE,
    });
  });
});
