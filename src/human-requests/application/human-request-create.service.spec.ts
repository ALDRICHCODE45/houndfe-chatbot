import { Logger } from '@nestjs/common';
import type {
  CancelHumanRequestResult,
  CreateHumanRequestInput,
  CreateHumanRequestResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { BackendOutboxEntry } from '../../backend-outbox/domain/backend-outbox';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { unknownQuestionDedupKey } from '../domain/human-request-create';
import {
  HumanRequestCreateService,
  type HumanRequestCreatePorts,
} from './human-request-create.service';

const SENDER = '5215550001111';
const REF = `wa:${SENDER}`;
const SOURCE = '3f1d2b6a-7c10-4c1e-9a52-0b8f5c0e6d7a';
const REQUEST = '7a1e0c3b-2d4f-4b6a-8c9d-0e1f2a3b4c5d';
const NOW = new Date('2026-11-10T16:20:00.000Z');
const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'casual' };
const QUESTION = '¿Este collar sirve para un gato de 3 kg?';

const created = (
  outcome: 'CREATED' | 'REPLAYED' | 'MERGED' = 'CREATED',
  patch: { id?: string | null; mergedIntoId?: string | null } = {},
): CreateHumanRequestResult => ({
  kind: 'ok',
  status: outcome === 'CREATED' ? 201 : 200,
  response: {
    id: patch.id === undefined ? REQUEST : patch.id,
    folio: 'HR-1',
    status: 'OPEN',
    outcome,
    mergedIntoId: patch.mergedIntoId ?? null,
    businessHours: null,
  },
});

function harness(
  options: {
    create?: CreateHumanRequestResult | Error;
    cancel?: CancelHumanRequestResult | Error;
    human?: boolean | Error;
    window?: boolean | Error;
    style?: CustomerStyle | null;
    enqueue?: Error;
  } = {},
) {
  const store = new InMemoryHumanRequestFeedStore();
  const createHumanRequest = jest.fn((input: CreateHumanRequestInput) => {
    void input;
    const next = options.create ?? created();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const cancelHumanRequest = jest.fn(() => {
    const next = options.cancel ?? {
      kind: 'ok' as const,
      response: {
        id: REQUEST,
        status: 'CANCELLED' as const,
        reason: 'CUSTOMER_WITHDREW',
        cancelledAt: NOW.toISOString(),
      },
    };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const enqueue = jest.fn(() =>
    options.enqueue
      ? Promise.reject(options.enqueue)
      : Promise.resolve({ entry: {} as BackendOutboxEntry, created: true }),
  );
  const sendText = jest.fn(() =>
    Promise.resolve({ providerMessageId: 'wamid.out' }),
  );
  const isHumanMode = jest.fn(() =>
    options.human instanceof Error
      ? Promise.reject(options.human)
      : Promise.resolve(options.human ?? false),
  );
  const isWindowOpen = jest.fn(() =>
    options.window instanceof Error
      ? Promise.reject(options.window)
      : Promise.resolve(options.window ?? true),
  );
  const ports: HumanRequestCreatePorts = {
    client: { createHumanRequest, cancelHumanRequest },
    store,
    outbox: { enqueue },
    sender: { sendText },
    handoff: { isHumanMode },
    isWindowOpen,
    customerStyle: () => Promise.resolve(options.style ?? null),
  };
  const service = new HumanRequestCreateService(ports, {
    clock: () => NOW,
    newSourceRequestId: () => SOURCE,
  });
  return {
    service,
    store,
    createHumanRequest,
    cancelHumanRequest,
    enqueue,
    sendText,
    isWindowOpen,
  };
}

const ask = (service: HumanRequestCreateService) =>
  service.askTeam({
    senderId: SENDER,
    question: QUESTION,
    summary: 'Compatibilidad de collar con gato de 3 kg',
    productIds: ['11111111-1111-4111-8111-111111111111'],
    inboundAt: '2026-11-10T16:19:30.000Z',
    triggerWaMessageId: 'wamid.Q1',
  });

const ENVELOPE = {
  sourceRequestId: SOURCE,
  subtype: 'UNKNOWN_QUESTION',
  customer: { phoneCountryCode: '52', phone: '5550001111' },
  conversationRef: REF,
  lastCustomerMessageAt: '2026-11-10T16:19:30.000Z',
  summary: 'Compatibilidad de collar con gato de 3 kg',
  needs: QUESTION,
  context: { productIds: ['11111111-1111-4111-8111-111111111111'] },
  dedupKey: unknownQuestionDedupKey(QUESTION),
  triggerWaMessageId: 'wamid.Q1',
};

const outboxEntry = (
  kind: 'REQUEST_CREATE' | 'REQUEST_CANCEL' | 'MESSAGE_MIRROR',
  payload: Record<string, unknown>,
  idempotencyKey = SOURCE,
): BackendOutboxEntry => ({
  id: '9',
  conversationRef: REF,
  seq: 4,
  kind,
  idempotencyKey,
  payload,
  status: 'IN_FLIGHT',
  attempts: 2,
  nextAttemptAt: NOW,
  leaseOwner: 'o',
  leaseExpiresAt: NOW,
  lastError: null,
  createdAt: NOW,
  doneAt: null,
});

describe('HumanRequestCreateService.askTeam', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['CREATED', 'REPLAYED'] as const)(
    '%s: sends the exact envelope and records the request OPEN',
    async (outcome) => {
      const h = harness({ create: created(outcome) });
      await expect(ask(h.service)).resolves.toEqual({
        kind: 'registered',
        requestId: REQUEST,
      });
      expect(h.createHumanRequest).toHaveBeenCalledWith(ENVELOPE);
      await expect(h.store.getRequest(REQUEST)).resolves.toMatchObject({
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
        legacyId: null,
        status: 'OPEN',
      });
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.sendText).not.toHaveBeenCalled();
    },
  );

  it('MERGED: records the request it merged into', async () => {
    const other = '00000000-1111-4222-8333-444444444444';
    const h = harness({ create: created('MERGED', { mergedIntoId: other }) });
    await expect(ask(h.service)).resolves.toEqual({
      kind: 'registered',
      requestId: other,
    });
    await expect(h.store.getRequest(other)).resolves.toMatchObject({
      status: 'OPEN',
    });
  });

  it('still reports registered when the local registry write fails', async () => {
    const h = harness();
    jest
      .spyOn(h.store, 'recordOpenRequest')
      .mockRejectedValue(new Error('db down'));
    await expect(ask(h.service)).resolves.toMatchObject({
      kind: 'registered',
    });
  });

  it('CUSTOMER_OPEN_LIMIT and CUSTOMER_RATE_LIMITED: no retry, no registry row', async () => {
    const limit = harness({
      create: { kind: 'CUSTOMER_OPEN_LIMIT', limit: 20, open: 20 },
    });
    await expect(ask(limit.service)).resolves.toEqual({ kind: 'open_limit' });
    const rate = harness({
      create: {
        kind: 'CUSTOMER_RATE_LIMITED',
        limit: 10,
        retryAfterSeconds: 600,
      },
    });
    await expect(ask(rate.service)).resolves.toEqual({
      kind: 'customer_rate_limited',
    });
    for (const h of [limit, rate]) {
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
      expect(h.enqueue).not.toHaveBeenCalled();
      await expect(h.store.getRequest(REQUEST)).resolves.toBeNull();
    }
  });

  it.each([
    ['a thrown transport error', new Error('timeout')],
    ['RATE_LIMITED', { kind: 'RATE_LIMITED', retryAfterSeconds: 30 } as const],
    ['VERSION_CONFLICT', { kind: 'VERSION_CONFLICT' } as const],
  ])('%s: queues REQUEST_CREATE with the same envelope', async (_l, create) => {
    const h = harness({ create });
    await expect(ask(h.service)).resolves.toEqual({ kind: 'queued' });
    expect(h.enqueue).toHaveBeenCalledWith({
      conversationRef: REF,
      kind: 'REQUEST_CREATE',
      idempotencyKey: SOURCE,
      payload: ENVELOPE,
    });
    await expect(h.store.getRequest(REQUEST)).resolves.toBeNull();
  });

  it('fails without a promise when the queue write fails too', async () => {
    const h = harness({
      create: new Error('timeout'),
      enqueue: new Error('x'),
    });
    await expect(ask(h.service)).resolves.toEqual({
      kind: 'failed',
      reason: 'queue_failed',
    });
  });

  it.each([
    { kind: 'VALIDATION_ERROR', message: 'bad' },
    { kind: 'SUBTYPE_DISABLED' },
    { kind: 'IDEMPOTENCY_CONFLICT' },
    { kind: 'SCHEDULING_DISABLED' },
    { kind: 'NOT_FOUND' },
  ] as const)('$kind: fails, logs an error, never queues', async (create) => {
    const error = jest.spyOn(Logger.prototype, 'error');
    const h = harness({ create });
    await expect(ask(h.service)).resolves.toEqual({
      kind: 'failed',
      reason: create.kind,
    });
    expect(error).toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('fails before any call for an unusable sender', async () => {
    const h = harness();
    await expect(
      h.service.askTeam({
        senderId: '15550001111',
        question: QUESTION,
        summary: 's',
      }),
    ).resolves.toEqual({ kind: 'failed', reason: 'invalid_envelope' });
    expect(h.createHumanRequest).not.toHaveBeenCalled();
  });
});

describe('HumanRequestCreateService.deliver (outbox adapter)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const create = () => outboxEntry('REQUEST_CREATE', ENVELOPE);

  it.each(['CREATED', 'REPLAYED', 'MERGED'] as const)(
    'REQUEST_CREATE %s → DELIVERED, registry OPEN, one confirmation',
    async (outcome) => {
      const h = harness({ create: created(outcome), style: TU });
      await expect(h.service.deliver(create())).resolves.toEqual({
        outcome: 'DELIVERED',
      });
      expect(h.createHumanRequest).toHaveBeenCalledWith(ENVELOPE);
      await expect(h.store.getRequest(REQUEST)).resolves.toMatchObject({
        status: 'OPEN',
        subtype: 'UNKNOWN_QUESTION',
      });
      expect(h.sendText).toHaveBeenCalledTimes(1);
      expect(h.sendText).toHaveBeenCalledWith({
        to: SENDER,
        text: 'Ya le pregunté al equipo, te aviso por aquí en cuanto me respondan.',
      });
    },
  );

  it('sends the usted confirmation without a stored style', async () => {
    const h = harness();
    await h.service.deliver(create());
    expect(h.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan.',
    });
  });

  it.each([
    ['the window is closed', { window: false }],
    ['the window read fails', { window: new Error('db') }],
    ['the conversation is in HUMAN mode', { human: true }],
    ['the mode is unreadable', { human: new Error('db') }],
  ])('skips the confirmation silently when %s', async (_l, patch) => {
    const h = harness(patch);
    await expect(h.service.deliver(create())).resolves.toEqual({
      outcome: 'DELIVERED',
    });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('a failed confirmation send never undoes the delivery', async () => {
    const h = harness();
    h.sendText.mockRejectedValue(new Error('meta down'));
    await expect(h.service.deliver(create())).resolves.toEqual({
      outcome: 'DELIVERED',
    });
  });

  it.each([
    [{ kind: 'RATE_LIMITED', retryAfterSeconds: 30 }, 30_000],
    [
      { kind: 'CUSTOMER_RATE_LIMITED', limit: 10, retryAfterSeconds: 600 },
      600_000,
    ],
    [{ kind: 'RATE_LIMITED', retryAfterSeconds: null }, undefined],
  ] as const)('%j → RETRY after Retry-After', async (result, retryAfterMs) => {
    const h = harness({ create: result });
    const delivered = await h.service.deliver(create());
    expect(delivered).toMatchObject({ outcome: 'RETRY' });
    expect((delivered as { retryAfterMs?: number }).retryAfterMs).toBe(
      retryAfterMs,
    );
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'CUSTOMER_OPEN_LIMIT', limit: 20, open: 20 },
    { kind: 'IDEMPOTENCY_CONFLICT' },
    { kind: 'SUBTYPE_DISABLED' },
    { kind: 'VALIDATION_ERROR', message: 'bad' },
  ] as const)('$kind → PERMANENT', async (result) => {
    const h = harness({ create: result });
    await expect(h.service.deliver(create())).resolves.toEqual({
      outcome: 'PERMANENT',
      error: result.kind,
    });
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('a thrown create is retryable (rethrown for the drain worker)', async () => {
    const h = harness({ create: new Error('socket hang up') });
    await expect(h.service.deliver(create())).rejects.toThrow('socket hang up');
  });

  it('a malformed stored envelope is PERMANENT without a call', async () => {
    const h = harness();
    await expect(
      h.service.deliver(outboxEntry('REQUEST_CREATE', { subtype: 'NOPE' })),
    ).resolves.toEqual({ outcome: 'PERMANENT', error: 'invalid payload' });
    expect(h.createHumanRequest).not.toHaveBeenCalled();
  });

  const cancel = (payload: Record<string, unknown> = {}) =>
    outboxEntry(
      'REQUEST_CANCEL',
      {
        requestId: REQUEST,
        reason: 'CUSTOMER_WITHDREW',
        triggerWaMessageId: 'wamid.C1',
        ...payload,
      },
      'cancel-key-1',
    );

  it('REQUEST_CANCEL ok → DELIVERED and closes the registry row', async () => {
    const h = harness();
    await h.store.recordOpenRequest({
      requestId: REQUEST,
      conversationRef: REF,
      subtype: 'UNKNOWN_QUESTION',
    });
    await expect(h.service.deliver(cancel())).resolves.toEqual({
      outcome: 'DELIVERED',
    });
    expect(h.cancelHumanRequest).toHaveBeenCalledWith(
      REQUEST,
      { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.C1' },
      'cancel-key-1',
    );
    await expect(h.store.getRequest(REQUEST)).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });

  it('REQUEST_CANCEL ALREADY_RESOLVED → DELIVERED, registry RESOLVED', async () => {
    const h = harness({
      cancel: { kind: 'ALREADY_RESOLVED', resolution: { text: 'x' } },
    });
    await h.store.recordOpenRequest({
      requestId: REQUEST,
      conversationRef: REF,
      subtype: 'UNKNOWN_QUESTION',
    });
    await expect(h.service.deliver(cancel())).resolves.toEqual({
      outcome: 'DELIVERED',
    });
    await expect(h.store.getRequest(REQUEST)).resolves.toMatchObject({
      status: 'RESOLVED',
    });
  });

  it('REQUEST_CANCEL RATE_LIMITED → RETRY; throws are retryable', async () => {
    const rate = harness({
      cancel: { kind: 'RATE_LIMITED', retryAfterSeconds: 5 },
    });
    await expect(rate.service.deliver(cancel())).resolves.toEqual({
      outcome: 'RETRY',
      error: 'RATE_LIMITED',
      retryAfterMs: 5_000,
    });
    const down = harness({ cancel: new Error('502') });
    await expect(down.service.deliver(cancel())).rejects.toThrow('502');
  });

  it.each([
    { kind: 'REQUEST_CLOSED' },
    { kind: 'CANCEL_NOT_ALLOWED' },
    { kind: 'NOT_FOUND' },
    { kind: 'IDEMPOTENCY_CONFLICT' },
  ] as const)('REQUEST_CANCEL $kind → PERMANENT', async (result) => {
    const h = harness({ cancel: result });
    await expect(h.service.deliver(cancel())).resolves.toEqual({
      outcome: 'PERMANENT',
      error: result.kind,
    });
  });

  it('a malformed cancel payload is PERMANENT without a call', async () => {
    const h = harness();
    await expect(
      h.service.deliver(cancel({ reason: 'BORED' })),
    ).resolves.toEqual({ outcome: 'PERMANENT', error: 'invalid payload' });
    expect(h.cancelHumanRequest).not.toHaveBeenCalled();
  });

  it('does not depend on being the conversation head (any seq)', async () => {
    const h = harness();
    const late = { ...create(), seq: 57 };
    await expect(h.service.deliver(late)).resolves.toEqual({
      outcome: 'DELIVERED',
    });
  });

  it('refuses kinds it does not own (wiring error)', async () => {
    const h = harness();
    await expect(
      h.service.deliver(outboxEntry('MESSAGE_MIRROR', {})),
    ).resolves.toMatchObject({ outcome: 'RETRY' });
    expect(h.createHumanRequest).not.toHaveBeenCalled();
  });
});
