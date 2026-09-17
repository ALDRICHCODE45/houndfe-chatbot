import type { ConversationState } from '../../conversation/domain/conversation-store';
import { isCanonicalObjectKey } from '../domain/object-storage.port';
import type {
  ReservationOutcome,
  ReserveInput,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import {
  ReceiptIngressService,
  type ReceiptIngressInput,
} from './receipt-ingress.service';

const SENDER = 'sender-1';
const WAMID = 'wamid.ABC';
const MEDIA = 'media-1';
const SALE = 'sale-A';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEND = /send|notify|deliver|llm|agent|schedule|outbox|worker|prompt/i;

const receipt = (id = 'r-1') => ({ id }) as ReceiptMediaRow;
const created = (): { kind: 'created'; receipt: ReceiptMediaRow } => ({
  kind: 'created',
  receipt: receipt(),
});
const input = (
  over: Partial<ReceiptIngressInput> = {},
): ReceiptIngressInput => ({
  senderId: SENDER,
  webhookMessageId: WAMID,
  providerMediaId: MEDIA,
  declaredMimeType: 'image/jpeg',
  ...over,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
};
type Reserve = (input: ReserveInput) => Promise<ReservationOutcome>;
const fixture = (
  placedSaleId: string | null = SALE,
  reserveImpl: Reserve = () => Promise.resolve(created()),
  enabled = true,
) => {
  const reserve = jest.fn(reserveImpl);
  const state =
    placedSaleId === null
      ? null
      : ({ data: { placedSaleId } } as ConversationState);
  const conversations = { getState: jest.fn(() => Promise.resolve(state)) };
  const service = new ReceiptIngressService({ enabled }, conversations, {
    admit: reserve,
  });
  return { service, conversations, reserve };
};
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('ReceiptIngressService TX1 admission (RM1, WA2)', () => {
  it('gates the kill-switch with no state read and no reservation', async () => {
    const { service, conversations, reserve } = fixture(SALE, undefined, false);
    await expect(service.admit(input())).resolves.toEqual({
      kind: 'disabled',
    });
    expect(conversations.getState).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each(['application/pdf', 'image/gif', 'IMAGE/JPEG', ''])(
    'returns unsupported-media for %s without a state read or reservation',
    async (declaredMimeType) => {
      const { service, conversations, reserve } = fixture();
      await expect(service.admit(input({ declaredMimeType }))).resolves.toEqual(
        { kind: 'unsupported-media' },
      );
      expect(conversations.getState).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('rejects media without a placed sale before any reservation', async () => {
    const { service, conversations, reserve } = fixture(null);
    await expect(service.admit(input())).resolves.toEqual({
      kind: 'no-placed-sale',
    });
    expect(conversations.getState).toHaveBeenCalledWith(SENDER);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('waits for the atomic receipt admission operation rather than the legacy reservation path', async () => {
    const admission = jest.fn<Promise<ReservationOutcome>, [ReserveInput]>(() =>
      Promise.resolve(created()),
    );
    const reserve = jest.fn<Promise<ReservationOutcome>, [ReserveInput]>(() =>
      Promise.reject(new Error('legacy reservation path used')),
    );
    const state = { data: { placedSaleId: SALE } } as ConversationState;
    const ingressStore = { admit: admission, reserve };
    const service = new ReceiptIngressService(
      { enabled: true },
      { getState: jest.fn(() => Promise.resolve(state)) },
      ingressStore,
    );

    await expect(service.admit(input())).resolves.toEqual({
      kind: 'reserved',
      receipt: { id: 'r-1' },
    });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('captures the placed sale in the exact immutable reservation identity', async () => {
    const outcome = created();
    const { service, reserve } = fixture(SALE, () => Promise.resolve(outcome));
    const decision = await service.admit(
      input({ declaredMimeType: 'image/png' }),
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    const reserved = reserve.mock.calls[0][0];
    expect(reserved).toMatchObject({
      webhookMessageId: WAMID,
      providerMediaId: MEDIA,
      senderId: SENDER,
      capturedSaleId: SALE,
      declaredMimeType: 'image/png',
    });
    expect(reserved.id).toMatch(UUID);
    expect(isCanonicalObjectKey(reserved.objectKey)).toBe(true);
    expect(decision).toEqual({ kind: 'reserved', receipt: { id: 'r-1' } });
    expect((decision as { receipt: ReceiptMediaRow }).receipt).toBe(
      outcome.receipt,
    );
  });

  // Unit claim is exactly ordering: admit() does not resolve before
  // reserve() resolves. The mock proves no COMMIT; durable-transaction
  // semantics stay with the concrete WU2B store and its PostgreSQL spec.
  it('does not resolve before reserve() resolves', async () => {
    const gate = deferred<ReservationOutcome>();
    const { service, reserve } = fixture(SALE, () => gate.promise);
    let settled = false;
    const decision = service.admit(input());
    void decision.then(() => (settled = true));
    await flush();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    gate.resolve(created());
    await expect(decision).resolves.toEqual({
      kind: 'reserved',
      receipt: { id: 'r-1' },
    });
    expect(settled).toBe(true);
  });

  it.each(['webhook-replayed', 'provider-media-reused'] as const)(
    'maps %s passthrough with the persisted receipt',
    async (kind) => {
      const outcome = { kind, receipt: receipt('r-9') } as ReservationOutcome;
      const { service } = fixture(SALE, () => Promise.resolve(outcome));
      await expect(service.admit(input())).resolves.toEqual({
        kind,
        receipt: { id: 'r-9' },
      });
    },
  );

  it('maps same-webhook/different-media to a closed conflict without a receipt', async () => {
    const { service } = fixture(SALE, () =>
      Promise.resolve({ kind: 'webhook-media-conflict' }),
    );
    const decision = await service.admit(input());
    expect(decision).toEqual({ kind: 'webhook-media-conflict' });
    expect(decision).not.toHaveProperty('receipt');
  });

  it('maps the overlapping second image to sender-active rejection', async () => {
    const { service } = fixture(SALE, () =>
      Promise.resolve({ kind: 'sender-active' } as ReservationOutcome),
    );
    await expect(service.admit(input())).resolves.toEqual({
      kind: 'sender-active',
    });
  });

  it('maps simultaneous first-image arbitration without identity pre-checks', async () => {
    // Unit-level store arbitration only: the mock makes the first reserve
    // call the accepted winner and the second the concurrent loser. Real
    // PostgreSQL unique-constraint arbitration stays WU2B store evidence.
    let call = 0;
    const { service, reserve } = fixture(SALE, () => {
      call += 1;
      return call === 1
        ? Promise.resolve(created())
        : Promise.resolve({ kind: 'sender-active' } as ReservationOutcome);
    });
    const [first, second] = await Promise.all([
      service.admit(input()),
      service.admit(input({ providerMediaId: 'media-2' })),
    ]);
    expect(reserve).toHaveBeenCalledTimes(2);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['reserved', 'sender-active']);
    expect(first).not.toEqual(second);
  });

  it('accepts a later reservation after a terminal receipt with fresh identities', async () => {
    // The first reservation returns a receipt already in the terminal
    // ATTACHED status (tracked ReceiptMediaStatus value); mapping a later
    // store-returned `created` to `reserved` is service-level only — the
    // database terminal-index admission gate itself remains existing WU2B
    // integration evidence.
    let call = 0;
    const { service, reserve } = fixture(SALE, () => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? ({
              kind: 'created',
              receipt: { id: 'r-1', status: 'ATTACHED' },
            } as { kind: 'created'; receipt: ReceiptMediaRow })
          : created(),
      );
    });
    const first = await service.admit(
      input({ webhookMessageId: 'wamid.1', providerMediaId: 'media-1' }),
    );
    expect(first).toEqual({
      kind: 'reserved',
      receipt: { id: 'r-1', status: 'ATTACHED' },
    });
    const second = await service.admit(
      input({ webhookMessageId: 'wamid.2', providerMediaId: 'media-2' }),
    );
    expect(second).toEqual({ kind: 'reserved', receipt: { id: 'r-1' } });
    expect(reserve).toHaveBeenCalledTimes(2);
    const [firstId, secondId] = reserve.mock.calls.map(([r]) => r.id);
    const [firstKey, secondKey] = reserve.mock.calls.map(([r]) => r.objectKey);
    expect(firstId).not.toBe(secondId);
    expect(firstKey).not.toBe(secondKey);
    expect(isCanonicalObjectKey(secondKey)).toBe(true);
  });

  it('propagates reservation rejection with no downstream action', async () => {
    const { service, reserve } = fixture(SALE, () =>
      Promise.reject(new Error('db-down')),
    );
    await expect(service.admit(input())).rejects.toThrow('db-down');
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('exposes no send/outbox/worker surface and preserves caller input', async () => {
    const { service, reserve } = fixture();
    await service.admit(Object.freeze(input()));
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service),
    ).filter((name) => SEND.test(name));
    expect(methods).toEqual([]);
    expect(reserve.mock.calls[0][0].webhookMessageId).toBe(WAMID);
    expect(reserve.mock.calls[0][0].senderId).toBe(SENDER);
  });
});
