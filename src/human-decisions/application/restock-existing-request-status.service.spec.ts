import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import {
  AuthError,
  ForbiddenError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { ChatbotApiHttpClient } from '../../chatbot-api/infrastructure/chatbot-api-http.client';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { RestockExistingRequestStatusService } from './restock-existing-request-status.service';

/**
 * HD-R1 recovery spec for the read-only `existing_restock` status service.
 *
 * The production bug: a trusted recorded RESTOCK receipt made the preflight
 * block with `existing_restock`, which the tool collapsed into the generic
 * `restock_unavailable`. This service proves the LOCAL accepted receipt and the
 * requested subject, then asks the backend for the CURRENT state. It is strictly
 * read-only: no POST, no coordinator, no legacy fallback, no marker writes.
 *
 * Only a same-subject recorded acceptance can succeed: `pending` needs a
 * validated GET, `response_recorded`/`stale` need a validated RESOLVED GET, and a
 * proven receipt with an unavailable/racy GET yields `current_status_unknown`.
 * Every malformed, forged, mismatched or unrecorded input stays `unavailable`.
 */
const SENDER = 'whatsapp:+5215500000001';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const OTHER_PRODUCT = '66666666-6666-4666-8666-666666666666';
const OTHER_VARIANT = '77777777-7777-4777-8777-777777777777';
const DECISION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_ID = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const BRANCH = 'branch-1';
const NOW = '2026-06-23T12:00:00.000Z';
const END = '2026-06-23T13:00:00.000Z';
const EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.ABC123',
};
const DIGEST = {
  productId: PRODUCT,
  name: 'Croquetas',
  variantId: VARIANT,
  quantity: 2,
};

const SNAPSHOT = {
  branchId: BRANCH,
  branchName: null,
  productId: PRODUCT,
  productName: 'Croquetas',
  variantId: VARIANT,
  sku: null,
  requestedQuantity: null,
  observedStockAtRequest: null,
  stockObservedAt: null,
};

function intake(over: Record<string, unknown> = {}) {
  return {
    sourceRequestId: SRC,
    type: 'RESTOCK',
    productId: PRODUCT,
    productName: 'Croquetas',
    variantId: VARIANT,
    sku: null,
    requestedQuantity: null,
    observedStockAtRequest: null,
    stockObservedAt: null,
    supersedesDecisionId: null,
    ...over,
  };
}

function context(over: Record<string, unknown> = {}) {
  return {
    reservation: {
      status: 'ACTIVE',
      route: 'RESTOCK',
      senderId: SENDER,
      requestKey: SRC,
      intake: intake(),
    },
    backendDecisionId: DECISION_ID,
    postAttemptedAt: NOW,
    receiptRecordedAt: NOW,
    ...over,
  };
}

function decision(over: Record<string, unknown> = {}) {
  return {
    id: DECISION_ID,
    sourceRequestId: SRC,
    type: 'RESTOCK',
    createdAt: NOW,
    snapshot: { ...SNAPSHOT },
    supersedesDecisionId: null,
    status: 'PENDING',
    version: 1,
    resolution: null,
    applyBefore: null,
    ...over,
  };
}

const resolved = (over: Record<string, unknown> = {}) =>
  decision({
    status: 'RESOLVED',
    version: 2,
    resolution: {
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 3,
      resolvedAt: NOW,
    },
    applyBefore: END,
    ...over,
  });

function grounded(senderId = SENDER) {
  const session = new CatalogSession(senderId, 60000, 0);
  session.installSearch(session.beginSearch(), [
    {
      productId: PRODUCT,
      name: 'Croquetas',
      variants: [
        { variantId: VARIANT, name: 'Variante', option: null, value: null },
      ],
    },
  ]);
  return session;
}

function setup(
  over: {
    read?: unknown;
    decision?: unknown;
    branch?: string;
    now?: string;
    fail?: 'read' | 'get' | 'clock';
  } = {},
) {
  const readRecordedForSender = jest
    .fn()
    .mockResolvedValue(
      'read' in over ? over.read : { action: 'recorded', context: context() },
    );
  const getRestockDecision = jest
    .fn()
    .mockResolvedValue('decision' in over ? over.decision : decision());
  const clock = jest.fn(() => new Date(over.now ?? NOW));
  if (over.fail === 'read') {
    readRecordedForSender.mockRejectedValue(new Error('db'));
  }
  if (over.fail === 'get') {
    getRestockDecision.mockRejectedValue(
      new UpstreamError('transport outage', null),
    );
  }
  if (over.fail === 'clock')
    clock.mockImplementation(() => {
      throw new Error('clock');
    });
  const service = new RestockExistingRequestStatusService(
    { readRecordedForSender },
    { getRestockDecision },
    over.branch ?? BRANCH,
    clock,
  );
  return { service, readRecordedForSender, getRestockDecision, clock };
}

const ask = (f: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
  f.service.recover({
    senderId: SENDER,
    inboundEvent: EVENT,
    digest: DIGEST,
    catalogSession: grounded(),
    ...over,
  });

const unavailable = { outcome: 'unavailable' };
const recorded = (status: string) => ({
  outcome: 'existing_restock_recorded',
  status,
});

describe('RestockExistingRequestStatusService', () => {
  it('reports pending only from a validated GET bound to the recorded subject', async () => {
    const f = setup();
    await expect(ask(f)).resolves.toEqual(recorded('pending'));
    expect(f.readRecordedForSender).toHaveBeenCalledTimes(1);
    expect(f.readRecordedForSender).toHaveBeenCalledWith(SENDER);
    expect(f.getRestockDecision).toHaveBeenCalledTimes(1);
    expect(f.getRestockDecision).toHaveBeenCalledWith(DECISION_ID);
  });

  it('reports response_recorded for a validated in-window RESOLVED decision without exposing its payload', async () => {
    const f = setup({ decision: resolved() });
    const result = await ask(f);
    expect(result).toEqual(recorded('response_recorded'));
    const wire = JSON.stringify(result);
    for (const secret of ['restockDays', '3', NOW, END, DECISION_ID, SRC]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('reports stale for a validated RESOLVED decision past applyBefore', async () => {
    const f = setup({ decision: resolved(), now: END });
    await expect(ask(f)).resolves.toEqual(recorded('stale'));
  });

  it('keeps a proven receipt as current_status_unknown when the GET is a transport outage', async () => {
    const thrown = setup({ fail: 'get' });
    await expect(ask(thrown)).resolves.toEqual(
      recorded('current_status_unknown'),
    );
    expect(thrown.getRestockDecision).toHaveBeenCalledTimes(1);
  });

  it('reports a malformed resolved current body as unavailable, never a claim', async () => {
    for (const bad of [null, {}, { status: 'RESOLVED' }, { id: OTHER_ID }]) {
      const f = setup({ decision: bad });
      await expect(ask(f)).resolves.toEqual(unavailable);
    }
  });

  it('keeps a race (clock before resolution) as current_status_unknown', async () => {
    const f = setup({
      decision: resolved(),
      now: '2026-06-23T11:59:59.999Z',
    });
    await expect(ask(f)).resolves.toEqual(recorded('current_status_unknown'));
  });

  it('reports unavailable with no GET for every unrecorded or ambiguous local read', async () => {
    for (const read of [
      undefined,
      null,
      { action: 'missing' },
      { action: 'hold' },
      { action: 'recorded' },
      { action: 'recorded', context: null },
    ]) {
      const f = setup({ read });
      await expect(ask(f)).resolves.toEqual(unavailable);
      expect(f.getRestockDecision).not.toHaveBeenCalled();
    }
    const f = setup({ fail: 'read' });
    await expect(ask(f)).resolves.toEqual(unavailable);
    expect(f.getRestockDecision).not.toHaveBeenCalled();
  });

  it.each([
    [
      'sender',
      { reservation: { ...context().reservation, senderId: 'other' } },
    ],
    ['status', { reservation: { ...context().reservation, status: 'CLOSED' } }],
    ['route', { reservation: { ...context().reservation, route: 'LEGACY' } }],
    [
      'requestKey',
      { reservation: { ...context().reservation, requestKey: OTHER_ID } },
    ],
    [
      'intake key',
      {
        reservation: {
          ...context().reservation,
          intake: intake({ sourceRequestId: OTHER_ID }),
        },
      },
    ],
    ['decision id', { backendDecisionId: 'not-a-uuid' }],
    ['decision id null', { backendDecisionId: null }],
    [
      'noncanonical intake',
      {
        reservation: {
          ...context().reservation,
          intake: intake({ productName: ' Croquetas ' }),
        },
      },
    ],
  ])(
    'reports unavailable with no GET for malformed local context (%s)',
    async (_label, patch) => {
      const f = setup({
        read: { action: 'recorded', context: context(patch) },
      });
      await expect(ask(f)).resolves.toEqual(unavailable);
      expect(f.getRestockDecision).not.toHaveBeenCalled();
    },
  );

  it('reports unavailable with no GET when the recorded subject does not match the request', async () => {
    for (const recordedIntake of [
      intake({ productId: OTHER_PRODUCT }),
      intake({ variantId: OTHER_VARIANT }),
      intake({ variantId: null }),
    ]) {
      const f = setup({
        read: {
          action: 'recorded',
          context: context({
            reservation: { ...context().reservation, intake: recordedIntake },
          }),
        },
      });
      await expect(ask(f)).resolves.toEqual(unavailable);
      expect(f.getRestockDecision).not.toHaveBeenCalled();
    }
  });

  it.each([
    [{ id: OTHER_ID }],
    [{ sourceRequestId: OTHER_ID }],
    [{ supersedesDecisionId: OTHER_ID }],
    [{ snapshot: { ...SNAPSHOT, productId: OTHER_PRODUCT } }],
    [{ snapshot: { ...SNAPSHOT, variantId: OTHER_VARIANT } }],
    [{ snapshot: { ...SNAPSHOT, productName: 'Other' } }],
    [{ snapshot: { ...SNAPSHOT, branchId: 'other-branch' } }],
  ])(
    'reports unavailable when the backend decision identity does not bind to the recorded receipt %#',
    async (patch) => {
      const f = setup({ decision: decision(patch) });
      await expect(ask(f)).resolves.toEqual(unavailable);
      expect(f.getRestockDecision).toHaveBeenCalledTimes(1);
    },
  );

  it('reports unavailable without reading for a forged, expired, cross-sender or missing session', async () => {
    let now = 1;
    const expired = new CatalogSession(SENDER, 0, 0, undefined, [], () => now);
    expired.installSearch(expired.beginSearch(), [
      {
        productId: PRODUCT,
        name: 'Croquetas',
        variants: [
          { variantId: VARIANT, name: 'Variante', option: null, value: null },
        ],
      },
    ]);
    now = 2;
    const forged = Object.assign(
      Object.create(CatalogSession.prototype) as CatalogSession,
      { senderId: SENDER, matches: () => true },
    );
    for (const catalogSession of [
      undefined,
      expired,
      grounded('another'),
      forged,
    ]) {
      const f = setup();
      await expect(ask(f, { catalogSession })).resolves.toEqual(unavailable);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
      expect(f.getRestockDecision).not.toHaveBeenCalled();
    }
  });

  it('reports unavailable when the session does not match the requested variant', async () => {
    const session = new CatalogSession(SENDER, 60000, 0);
    session.installSearch(session.beginSearch(), [
      {
        productId: PRODUCT,
        name: 'Croquetas',
        variants: [
          { variantId: OTHER_VARIANT, name: 'Otra', option: null, value: null },
        ],
      },
    ]);
    const f = setup();
    await expect(ask(f, { catalogSession: session })).resolves.toEqual(
      unavailable,
    );
    expect(f.readRecordedForSender).not.toHaveBeenCalled();
  });

  it('reports unavailable when the session does not match the requested product', async () => {
    const session = new CatalogSession(SENDER, 60000, 0);
    session.installSearch(session.beginSearch(), [
      {
        productId: OTHER_PRODUCT,
        name: 'Croquetas',
        variants: [
          { variantId: VARIANT, name: 'Variante', option: null, value: null },
        ],
      },
    ]);
    const f = setup();
    await expect(ask(f, { catalogSession: session })).resolves.toEqual(
      unavailable,
    );
    expect(f.readRecordedForSender).not.toHaveBeenCalled();
  });

  it('treats the model display name as non-identity: a renamed digest still recovers the recorded subject', async () => {
    const f = setup();
    await expect(
      ask(f, { digest: { ...DIGEST, name: 'Otro nombre' } }),
    ).resolves.toEqual(recorded('pending'));
    expect(f.getRestockDecision).toHaveBeenCalledWith(DECISION_ID);
  });

  it.each([
    undefined,
    null,
    'x',
    {},
    { ...EVENT, senderId: 'whatsapp:+5215500000999' },
    { ...EVENT, extra: 'x' },
    { ...EVENT, messageId: 1 },
  ])(
    'reports unavailable without reading for an unbound inbound event %#',
    async (inboundEvent) => {
      const f = setup();
      await expect(ask(f, { inboundEvent })).resolves.toEqual(unavailable);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    null,
    'x',
    {},
    { productId: 'nope', name: 'x' },
    { productId: PRODUCT, name: '' },
    { productId: PRODUCT, name: 'x', variantId: 'nope' },
  ])(
    'reports unavailable without reading for an invalid digest %#',
    async (digest) => {
      const f = setup();
      await expect(ask(f, { digest })).resolves.toEqual(unavailable);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' ', ' padded', null, 42])(
    'reports unavailable without reading for an invalid sender %p',
    async (senderId) => {
      const f = setup();
      await expect(ask(f, { senderId })).resolves.toEqual(unavailable);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
    },
  );

  it('reports unavailable without reading for an invalid branch configuration', async () => {
    for (const branch of ['', ' ']) {
      const f = setup({ branch });
      await expect(ask(f)).resolves.toEqual(unavailable);
      expect(f.readRecordedForSender).not.toHaveBeenCalled();
    }
  });

  it('reports unavailable when the clock throws', async () => {
    const f = setup({ decision: resolved(), fail: 'clock' });
    await expect(ask(f)).resolves.toEqual(unavailable);
  });

  it('never throws: the entire result surface is frozen data', async () => {
    const f = setup();
    const result = await ask(f);
    expect(Object.isFrozen(result)).toBe(true);
    const hostile = setup({
      decision: {
        get id(): string {
          throw new Error('hostile');
        },
      },
    });
    await expect(ask(hostile)).resolves.toEqual(unavailable);
  });
});

/** Complete `AxiosResponse` fixture so the real client stays type-checked. */
function axiosResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

describe('RestockExistingRequestStatusService current-state error boundaries', () => {
  it.each([
    ['transport outage', new UpstreamError('socket down', null)],
    ['5xx outage', new UpstreamError('upstream down', 503)],
  ])(
    'keeps a receipt-backed %s as current_status_unknown',
    async (_label, error) => {
      const f = setup();
      f.getRestockDecision.mockRejectedValue(error);
      await expect(ask(f)).resolves.toEqual(recorded('current_status_unknown'));
    },
  );

  it.each([
    ['invalid 200 body', new UpstreamError('invalid', 200, { bad: true })],
    ['unexpected 201 status', new UpstreamError('unexpected', 201)],
    ['401 auth', new AuthError('auth failed', 401)],
    ['403 forbidden', new ForbiddenError('forbidden', 403)],
    ['non-HTTP throw', new Error('boom')],
  ])(
    'reports %s as unavailable rather than a retriable unknown',
    async (_label, error) => {
      const f = setup();
      f.getRestockDecision.mockRejectedValue(error);
      await expect(ask(f)).resolves.toEqual(unavailable);
    },
  );
});

describe('RestockExistingRequestStatusService against the real HTTP client shape', () => {
  function realClient() {
    const httpService = new HttpService();
    const request = jest
      .spyOn(httpService, 'request')
      .mockImplementation(() =>
        throwError(() => new Error('unexpected network request')),
      );
    const config = new ConfigService({
      chatbotApi: {
        baseUrl: 'https://backend.example.com',
        serviceKey: 'svc_test_key',
        branchId: BRANCH,
      },
      receiptMedia: { attachTimeoutMs: 15000 },
    });
    const client = new ChatbotApiHttpClient(
      httpService,
      config,
      async () => undefined,
    );
    return { request, client };
  }

  const recoverWith = (
    backend: Pick<ChatbotApiHttpClient, 'getRestockDecision'>,
  ) => {
    const readRecordedForSender = jest
      .fn()
      .mockResolvedValue({ action: 'recorded', context: context() });
    return new RestockExistingRequestStatusService(
      { readRecordedForSender },
      backend,
      BRANCH,
      () => new Date(NOW),
    ).recover({
      senderId: SENDER,
      inboundEvent: EVENT,
      digest: DIGEST,
      catalogSession: grounded(),
    });
  };

  it('maps a real 200 malformed body to unavailable (wrong identity never becomes unknown)', async () => {
    const { request, client } = realClient();
    request.mockReturnValueOnce(of(axiosResponse({ garbage: true })));
    await expect(recoverWith(client)).resolves.toEqual(unavailable);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('maps a real foreign 200 decision id to unavailable', async () => {
    const { request, client } = realClient();
    request.mockReturnValueOnce(
      of(
        axiosResponse({
          id: OTHER_ID,
          sourceRequestId: SRC,
          type: 'RESTOCK',
          status: 'PENDING',
          version: 1,
          createdAt: NOW,
          snapshot: { ...SNAPSHOT },
          supersedesDecisionId: null,
          resolution: null,
          applyBefore: null,
        }),
      ),
    );
    await expect(recoverWith(client)).resolves.toEqual(unavailable);
  });

  it('maps a real persistent 5xx outage to current_status_unknown', async () => {
    const { request, client } = realClient();
    request.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: { statusCode: 503, code: 'UPSTREAM_DOWN', message: 'x' },
        },
      })),
    );
    await expect(recoverWith(client)).resolves.toEqual(
      recorded('current_status_unknown'),
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('maps a real 401 to unavailable rather than a produced pending state', async () => {
    const { request, client } = realClient();
    request.mockReturnValue(
      throwError(() => ({ response: { status: 401, data: {} } })),
    );
    await expect(recoverWith(client)).resolves.toEqual(unavailable);
  });
});
