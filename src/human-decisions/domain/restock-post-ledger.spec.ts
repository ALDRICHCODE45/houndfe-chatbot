import {
  classifyPostTransition,
  type RestockPostBlockedReason,
  type RestockPostDecision,
  type RestockPostRow,
  type RestockPostStep,
} from './restock-post-ledger';

const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const DECISION = '33333333-3333-4333-8333-333333333333';
const OTHER_DECISION = '44444444-4444-4444-8444-444444444444';

const row = (o: Partial<RestockPostRow> = {}): RestockPostRow => ({
  status: 'RESERVED',
  senderId: SENDER,
  sourceRequestId: SOURCE,
  backendDecisionId: null,
  ...o,
});
const recorded = () =>
  row({ status: 'RECEIPT_RECORDED', backendDecisionId: DECISION });
const inFlight = row({ status: 'POST_IN_FLIGHT' });
const unknownRow = row({ status: 'UNKNOWN' });
const BEGIN: RestockPostStep = { kind: 'begin_post' };
const UNKNOWN_STEP: RestockPostStep = { kind: 'mark_unknown' };
const receipt = (backendDecisionId: string): RestockPostStep => ({
  kind: 'record_receipt',
  backendDecisionId,
});
const B = (reason: RestockPostBlockedReason): RestockPostDecision => ({
  action: 'blocked',
  reason,
});
const AUTH: RestockPostDecision = { action: 'authorize_post' };
const HF: RestockPostDecision = { action: 'hold', reason: 'post_in_flight' };
const HU: RestockPostDecision = { action: 'hold', reason: 'unknown_state' };
const HA: RestockPostDecision = { action: 'hold', reason: 'already_unknown' };
const UP: RestockPostDecision = { action: 'mark_unknown', reason: 'pre_post' };
const UA: RestockPostDecision = {
  action: 'mark_unknown',
  reason: 'ambiguous_post',
};
const HIST = (id: string): RestockPostDecision => ({
  action: 'historical_receipt',
  backendDecisionId: id,
});
const REC = (id: string): RestockPostDecision => ({
  action: 'record_receipt',
  backendDecisionId: id,
});
const REP = (id: string): RestockPostDecision => ({
  action: 'replay_receipt',
  backendDecisionId: id,
});
const CONF = (id: string): RestockPostDecision => ({
  action: 'conflict',
  storedBackendDecisionId: id,
});
const run = (
  existing: RestockPostRow | 'absent' | 'unknown',
  step: RestockPostStep,
): RestockPostDecision =>
  classifyPostTransition({
    senderId: SENDER,
    sourceRequestId: SOURCE,
    existing,
    step,
  });

const MATRIX: Array<
  [
    string,
    RestockPostRow | 'absent' | 'unknown',
    RestockPostStep,
    RestockPostDecision,
  ]
> = [
  ['begin RESERVED', row(), BEGIN, AUTH],
  ['begin IN_FLIGHT', inFlight, BEGIN, HF],
  ['begin UNKNOWN', unknownRow, BEGIN, HU],
  ['begin RECORDED', recorded(), BEGIN, HIST(DECISION)],
  ['record IN_FLIGHT', inFlight, receipt(DECISION), REC(DECISION)],
  ['record replay', recorded(), receipt(DECISION), REP(DECISION)],
  ['record conflict', recorded(), receipt(OTHER_DECISION), CONF(DECISION)],
  ['record RESERVED', row(), receipt(DECISION), B('not_in_flight')],
  ['record UNKNOWN', unknownRow, receipt(DECISION), B('unknown_state')],
  ['unknown RESERVED', row(), UNKNOWN_STEP, UP],
  ['unknown IN_FLIGHT', inFlight, UNKNOWN_STEP, UA],
  ['unknown UNKNOWN', unknownRow, UNKNOWN_STEP, HA],
  ['unknown RECORDED', recorded(), UNKNOWN_STEP, B('receipt_recorded')],
];

describe('classifyPostTransition', () => {
  it.each(MATRIX)('%s', (_name, existing, step, expected) => {
    expect(run(existing, step)).toEqual(expected);
  });
});
