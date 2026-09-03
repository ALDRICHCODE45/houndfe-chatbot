import type { StatusCasInput } from '../domain/receipt-media-store.port';
import type { ReceiptTelemetryPort } from '../domain/receipt-telemetry.port';
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';
import {
  ReceiptOutboxService,
  type ReceiptTx2CommitPort,
  type ReceiptTx2Request,
} from './receipt-outbox.service';
type Commit = ReceiptTx2CommitPort['commitTransitionWithIntent'];
type Key = ReceiptTx2Request['templateKey'];
type Row = ReceiptMediaOutboxRow;
const DEDUPE = 'receipt:RECEIPT_AMOUNT_PROMPT:wamid.A:r-1:1';
const LABEL = { templateKey: 'RECEIPT_AMOUNT_PROMPT' };
const CONFIRM = 'RECEIPT_AMOUNT_CONFIRM';
const ATTACHED = 'RECEIPT_ATTACHED_PENDING';
const BAD_ARGS = 'TEMPLATE_ARGS_INVALID';
const TX2_FAILED =
  /^receipt-media:RECEIPT_OUTBOX_TX2_FAILED\/TX2_COMMIT_FAILED$/;
const LOST = { kind: 'transition-lost' } as const;
const SEND = /send|notify|deliver|llm|agent|schedule/i;
const done = (intent: Row, created = true) =>
  Promise.resolve({ kind: 'committed', created, intent } as const);
const throws = (): never => {
  throw new Error('TELEMETRY-SENTINEL');
};
const tx2Fails = () => Promise.reject(new Error('db-down wamid.PII-SENTINEL'));
const args = (templateKey: Key, templateArgs = {}) =>
  ({ templateKey, templateArgs }) as Partial<ReceiptTx2Request>;
const transition = {
  id: 'r-1',
  owner: 'worker-1',
  expectedStatus: 'STORED',
  expectedVersion: '1',
  nextStatus: 'AWAITING_AMOUNT',
} as StatusCasInput;
const request = (over: Partial<ReceiptTx2Request> = {}): ReceiptTx2Request => ({
  transition,
  sourceWebhookMessageId: 'wamid.A',
  recipientId: 'sender-1',
  templateKey: 'RECEIPT_AMOUNT_PROMPT',
  ...over,
});
const render = (over = {}) => fixture().service.renderIntent(request(over));
const fixture = (impl?: Commit, record?: ReceiptTelemetryPort['record']) => {
  const calls: Parameters<Commit>[0][] = [];
  const events: unknown[] = [];
  const port: ReceiptTx2CommitPort = {
    commitTransitionWithIntent: async (input) => {
      calls.push(input);
      const intent = input.intent as Row;
      return impl ? impl(input) : { kind: 'committed', created: true, intent };
    },
  };
  const telemetry: ReceiptTelemetryPort = {
    record: record ?? ((event, labels) => events.push([event, labels])),
  };
  return { service: new ReceiptOutboxService(port, telemetry), calls, events };
};
describe('ReceiptOutboxService TX2 (RM3, WA2)', () => {
  it('commits atomically in one TX2 call with a deterministic causal intent', async () => {
    const { service, calls, events } = fixture();
    const result = await service.commit(request());
    expect(calls).toHaveLength(1);
    expect(calls[0].transition).toEqual(transition);
    expect(service.renderIntent(request())).toEqual(calls[0].intent);
    expect(calls[0].intent.dedupeKey).toBe(DEDUPE);
    expect(calls[0].intent.receiptMediaId).toBe('r-1');
    expect(calls[0].intent.receiptStateVersion).toBe('1');
    expect(calls[0].intent.sourceWebhookMessageId).toBe('wamid.A');
    expect(result).toMatchObject({ kind: 'committed', created: true });
    expect(events).toEqual([['receipt_outbox_tx2_committed', LABEL]]);
  });
  it.each([
    ['unknown key', { templateKey: 'NOT_A_KEY' }, 'TEMPLATE_KEY_UNKNOWN'],
    ['arg name', { templateArgs: { x: 1 } }, BAD_ARGS],
    ['missing inbound id', { sourceWebhookMessageId: '' }, 'IDENTITY_INVALID'],
    ['missing cents', args(CONFIRM), BAD_ARGS],
    ['wrong-typed cents', args(CONFIRM, { amountCents: 'PENDING' }), BAD_ARGS],
    ['non-integer cents', args(CONFIRM, { amountCents: 1.5 }), BAD_ARGS],
    ['negative cents', args(CONFIRM, { amountCents: -1 }), BAD_ARGS],
    ['unsafe cents', args(CONFIRM, { amountCents: 2 ** 53 }), BAD_ARGS],
    ['missing backend status', args(ATTACHED), BAD_ARGS],
    ['wrong-typed status', args(ATTACHED, { backendStatus: 123 }), BAD_ARGS],
    ['bad status', args(ATTACHED, { backendStatus: 'SENT' }), BAD_ARGS],
  ] as [string, Partial<ReceiptTx2Request>, string][])(
    'guards %s without touching the port',
    async (_name, over, code) => {
      const { service, calls } = fixture();
      const action = service.commit({ ...request(), ...over });
      await expect(action).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(0);
    },
  );
  it.each([
    [CONFIRM, { amountCents: 0 }],
    [CONFIRM, { amountCents: Number.MAX_SAFE_INTEGER }],
    [ATTACHED, { backendStatus: 'PENDING' }],
  ])('accepts exact bounded args for %s', (templateKey, templateArgs) => {
    const intent = render(args(templateKey as Key, templateArgs));
    expect(intent.templateArgs).toEqual(templateArgs);
  });
  it('keeps committed and transition-lost results when telemetry throws', async () => {
    const committed = fixture(undefined, throws).service.commit(request());
    const lost = fixture(() => Promise.resolve(LOST), throws);
    await expect(committed).resolves.toMatchObject({ kind: 'committed' });
    await expect(lost.service.commit(request())).resolves.toEqual(LOST);
  });
  it('maps a crash before commit to a safe error, no partial intent', async () => {
    const { service, calls } = fixture(tx2Fails, throws);
    const action = service.commit(request());
    await expect(action).rejects.toThrow(TX2_FAILED);
    await expect(action).rejects.not.toThrow(/PII-SENTINEL|TELEMETRY-SENTINEL/);
    expect(calls).toHaveLength(1);
  });
  it('replays duplicate transitions without creating a different intent', async () => {
    let version = '1';
    const stored: Row[] = [];
    const { service, events } = fixture((input) => {
      if (input.transition.expectedVersion !== version)
        return Promise.resolve(LOST);
      version = '2';
      stored.push(input.intent as Row);
      return done(stored[0]);
    });
    expect((await service.commit(request())).kind).toBe('committed');
    await expect(service.commit(request())).resolves.toEqual(LOST);
    expect(stored).toHaveLength(1);
    expect(events[1]).toEqual(['receipt_outbox_tx2_transition_lost', LABEL]);
  });
  it('replays the persisted intent after a post-commit crash/conflict', async () => {
    const persisted = { id: 'ob-1', dedupeKey: DEDUPE } as Row;
    const expected = await done(persisted, false);
    const { service } = fixture(() => Promise.resolve(expected));
    await expect(service.commit(request())).resolves.toEqual(expected);
  });
  it('sends nothing: the service exposes no send/LLM/notify surface', async () => {
    const { service, calls } = fixture();
    await service.commit(request());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
    expect(methods.filter((name) => SEND.test(name))).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
