import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import type {
  DeliveryZoneRequester,
  DeliveryZoneResolution,
} from '../../chatbot-api/domain/dtos/human-decisions-delivery-zone.dto';
import type { CustomerInboundObservationLatest } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import type { DeliveryZoneRequesterRow } from '../domain/delivery-zone-requester';
import { InMemoryDeliveryZoneRequesterStore } from '../infrastructure/in-memory-delivery-zone-requester.store';
import { DeliveryZoneNotifier } from './delivery-zone-notifier';

const SENDER = '5215512345678';
const PHONE_ID = '123456789';
const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const REQUESTER = 'c41b2c3d-1111-4222-8333-444455556666';
const DECISION = '8a2f0000-1111-4222-8333-444455556666';
const ATTEMPT = '9b2f0000-1111-4222-8333-444455556666';
const RESOLVED_AT = '2026-11-05T18:00:00.000Z';
const APPLY_BEFORE = '2026-11-06T18:00:00.000Z';
const INSIDE = '2026-11-05T18:10:00.000Z';
const seconds = (iso: string) => String(Date.parse(iso) / 1000);

function row(patch: Partial<DeliveryZoneRequesterRow> = {}) {
  const value: DeliveryZoneRequesterRow = {
    sourceRequestId: SOURCE,
    senderId: SENDER,
    zipCode: '06700',
    intake: {
      sourceRequestId: SOURCE,
      type: 'DELIVERY_ZONE',
      zipCode: '06700',
      state: 'Ciudad de México',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Roma Norte',
      phoneCountryCode: '52',
      phone: '5512345678',
      conversationRef: `wa:${SENDER}`,
      lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
    },
    requesterId: REQUESTER,
    status: 'PENDING',
    lastPolledAt: null,
    resolution: null,
    applyBefore: null,
    channel: null,
    attemptId: null,
    attemptedAt: null,
    deliveryOutcome: null,
    providerMessageId: null,
    providerAcceptedObservedAt: null,
    notifiedAt: null,
    ackOutcome: null,
    ackedAt: null,
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
    ...patch,
  };
  return value;
}
const resolution = (
  patch: Partial<DeliveryZoneResolution> = {},
): DeliveryZoneResolution => ({
  source: 'VALIDATION',
  zoneType: 'FREE',
  resolvedAt: RESOLVED_AT,
  ...patch,
});
const resolvedPoll = (
  patch: Partial<DeliveryZoneResolution> = {},
): DeliveryZoneRequester => ({
  id: REQUESTER,
  sourceRequestId: SOURCE,
  type: 'DELIVERY_ZONE',
  status: 'RESOLVED',
  version: 2,
  createdAt: '2026-11-05T10:00:00.000Z',
  decisionId: DECISION,
  snapshot: {
    branchName: 'Centro',
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
  resolution: resolution(patch),
  applyBefore: APPLY_BEFORE,
});
const inbound = (iso: string): CustomerInboundObservationLatest => ({
  kind: 'found',
  observation: {
    senderId: SENDER,
    receivingPhoneNumberId: PHONE_ID,
    messageId: 'wamid.1',
    providerTimestampSeconds: seconds(iso),
    observedAt: iso,
  },
});

function setup(
  options: { now?: string; latest?: CustomerInboundObservationLatest } = {},
) {
  let now = options.now ?? INSIDE;
  const store = new InMemoryDeliveryZoneRequesterStore();
  const ports = {
    getDeliveryZoneRequester: jest.fn(),
    recordRestockApplicationOutcome: jest.fn().mockResolvedValue({}),
    sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid.text' }),
    sendTemplate: jest
      .fn()
      .mockResolvedValue({ providerMessageId: 'wamid.tpl' }),
    readLatest: jest
      .fn()
      .mockResolvedValue(options.latest ?? inbound('2026-11-05T17:00:00.000Z')),
    clearPendingQuote: jest.fn().mockResolvedValue(undefined),
    submit: jest.fn().mockResolvedValue(undefined),
  };
  const notifier = new DeliveryZoneNotifier(
    store,
    ports,
    PHONE_ID,
    () => new Date(now),
    () => ATTEMPT,
  );
  const seed = (value: DeliveryZoneRequesterRow) =>
    store.rows.set(value.sourceRequestId, value);
  return {
    store,
    ports,
    notifier,
    seed,
    setNow: (iso: string) => (now = iso),
    stored: () => store.rows.get(SOURCE)!,
  };
}

describe('DeliveryZoneNotifier', () => {
  it('keeps polling a PENDING requester and records the poll time', async () => {
    const t = setup();
    t.seed(row());
    t.ports.getDeliveryZoneRequester.mockResolvedValue({
      ...resolvedPoll(),
      status: 'PENDING',
      version: 1,
      resolution: null,
      applyBefore: null,
    });
    await t.notifier.process(t.stored());
    expect(t.ports.getDeliveryZoneRequester).toHaveBeenCalledWith(REQUESTER);
    expect(t.stored()).toMatchObject({
      status: 'PENDING',
      lastPolledAt: INSIDE,
    });
    expect(t.ports.sendText).not.toHaveBeenCalled();
  });

  it('resolved inside both windows: sends the text and ACKs PROVIDER_ACCEPTED', async () => {
    const t = setup();
    t.seed(row());
    t.ports.getDeliveryZoneRequester.mockResolvedValue(resolvedPoll());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: '¡Listo! Ya tenemos entrega a su código postal 06700. Pídame de nuevo el envío y le muestro el costo actualizado.',
    });
    expect(t.ports.sendTemplate).not.toHaveBeenCalled();
    expect(t.ports.recordRestockApplicationOutcome).toHaveBeenCalledWith(
      REQUESTER,
      {
        attemptId: ATTEMPT,
        expectedResolutionVersion: 2,
        outcome: 'PROVIDER_ACCEPTED',
        attemptedAt: INSIDE,
        providerMessageId: 'wamid.text',
        providerAcceptedObservedAt: INSIDE,
      },
    );
    expect(t.ports.clearPendingQuote).toHaveBeenCalledWith(SENDER);
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      channel: 'TEXT',
      deliveryOutcome: 'PROVIDER_ACCEPTED',
      notifiedAt: INSIDE,
      ackOutcome: 'PROVIDER_ACCEPTED',
      ackedAt: INSIDE,
    });
  });

  it('DENIED sends the pickup text', async () => {
    const t = setup();
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution({ zoneType: 'DENIED' }),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Revisamos su código postal 06700 y por ahora no tenemos entrega ahí. Puede recoger su pedido en tienda sin costo de envío.',
    });
  });

  it('an EXISTING_ZONE requester stored RESOLVED is delivered without a poll', async () => {
    const t = setup();
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution({ source: 'EXISTING_ZONE' }),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.ports.getDeliveryZoneRequester).not.toHaveBeenCalled();
    expect(t.ports.sendText).toHaveBeenCalledTimes(1);
    expect(t.stored().status).toBe('CLOSED');
  });

  it('outside the customer 24h window: sends the template and still ACKs inside the ACK window', async () => {
    const t = setup({ latest: inbound('2026-11-04T10:00:00.000Z') });
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).not.toHaveBeenCalled();
    expect(t.ports.sendTemplate).toHaveBeenCalledWith({
      to: SENDER,
      templateName: 'zona_entrega_revisada',
      languageCode: 'es_MX',
      bodyParameters: ['06700'],
    });
    expect(t.ports.recordRestockApplicationOutcome).toHaveBeenCalledWith(
      REQUESTER,
      expect.objectContaining({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.tpl',
      }),
    );
    expect(t.stored()).toMatchObject({ status: 'CLOSED', channel: 'TEMPLATE' });
  });

  it('no inbound evidence counts as outside the customer window', async () => {
    const t = setup({ latest: { kind: 'missing' } });
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.ports.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('outside the ACK window: template, PROVIDER_ACCEPTED_LATE recorded locally, no ACK', async () => {
    const late = '2026-11-08T12:00:00.000Z';
    const t = setup({ now: late, latest: inbound('2026-11-05T10:00:00.000Z') });
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.ports.sendTemplate).toHaveBeenCalledTimes(1);
    expect(t.ports.recordRestockApplicationOutcome).not.toHaveBeenCalled();
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      deliveryOutcome: 'PROVIDER_ACCEPTED_LATE',
      ackOutcome: null,
      ackedAt: null,
    });
  });

  it('template failure records DELIVERY_UNKNOWN once and ACKs it inside the window', async () => {
    const t = setup({ latest: { kind: 'missing' } });
    t.ports.sendTemplate.mockRejectedValue(new Error('template not approved'));
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    await t.notifier.process(t.stored());
    expect(t.ports.sendTemplate).toHaveBeenCalledTimes(1);
    expect(t.ports.recordRestockApplicationOutcome).toHaveBeenCalledTimes(1);
    expect(t.ports.recordRestockApplicationOutcome).toHaveBeenCalledWith(
      REQUESTER,
      {
        attemptId: ATTEMPT,
        expectedResolutionVersion: 2,
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: INSIDE,
      },
    );
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      deliveryOutcome: 'DELIVERY_UNKNOWN',
      ackOutcome: 'DELIVERY_UNKNOWN',
    });
  });

  it('a crash after SEND_STARTED never resends: recovery records DELIVERY_UNKNOWN', async () => {
    const t = setup();
    t.seed(
      row({
        status: 'SEND_STARTED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
        channel: 'TEXT',
        attemptId: ATTEMPT,
        attemptedAt: INSIDE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).not.toHaveBeenCalled();
    expect(t.ports.sendTemplate).not.toHaveBeenCalled();
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      deliveryOutcome: 'DELIVERY_UNKNOWN',
      ackOutcome: 'DELIVERY_UNKNOWN',
    });
  });

  it('a transient ACK failure keeps NOTIFIED and the next pass ACKs without resending', async () => {
    const t = setup();
    t.ports.recordRestockApplicationOutcome.mockRejectedValueOnce(
      new UpstreamError('down', 503),
    );
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.stored().status).toBe('NOTIFIED');
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenCalledTimes(1);
    expect(t.ports.recordRestockApplicationOutcome).toHaveBeenCalledTimes(2);
    expect(t.ports.recordRestockApplicationOutcome.mock.calls[1]).toEqual(
      t.ports.recordRestockApplicationOutcome.mock.calls[0],
    );
    expect(t.stored().status).toBe('CLOSED');
  });

  it('a 4xx ACK rejection closes locally without looping', async () => {
    const t = setup();
    t.ports.recordRestockApplicationOutcome.mockRejectedValue(
      new ChatbotApiError('x', 409, {}, 'OUTCOME_ALREADY_RECORDED'),
    );
    t.seed(
      row({
        status: 'RESOLVED',
        resolution: resolution(),
        applyBefore: APPLY_BEFORE,
      }),
    );
    await t.notifier.process(t.stored());
    expect(t.stored()).toMatchObject({ status: 'CLOSED', ackOutcome: null });
  });

  it('retries a stored INTAKE_PENDING requester through the intake', async () => {
    const t = setup();
    t.seed(row({ status: 'INTAKE_PENDING', requesterId: null }));
    await t.notifier.process(t.stored());
    expect(t.ports.submit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRequestId: SOURCE }),
    );
  });
});

describe('DeliveryZoneNotifier customer style (S1)', () => {
  const resolved = () =>
    row({
      status: 'RESOLVED',
      resolution: resolution({ zoneType: 'DENIED' }),
      applyBefore: APPLY_BEFORE,
    });
  const USTED =
    'Revisamos su código postal 06700 y por ahora no tenemos entrega ahí. Puede recoger su pedido en tienda sin costo de envío.';

  it('a tú profile gets the tú text', async () => {
    const t = setup();
    const customerStyle = jest
      .fn()
      .mockResolvedValue({ register: 'tu', emojis: false, tone: 'casual' });
    Object.assign(t.ports, { customerStyle });
    t.seed(resolved());
    await t.notifier.process(t.stored());
    expect(customerStyle).toHaveBeenCalledWith(SENDER);
    expect(t.ports.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Revisamos tu código postal 06700 y por ahora no tenemos entrega ahí. Puedes recoger tu pedido en tienda sin costo de envío.',
    });
  });

  it.each([
    ['missing profile', () => Promise.resolve(null)],
    ['failed read', () => Promise.reject(new Error('down'))],
  ])('%s keeps the usted text', async (_label, read) => {
    const t = setup();
    Object.assign(t.ports, { customerStyle: jest.fn(read) });
    t.seed(resolved());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenCalledWith({ to: SENDER, text: USTED });
    expect(t.stored()).toMatchObject({ status: 'CLOSED' });
  });

  it('the Meta template outside the window is unchanged', async () => {
    const t = setup({ latest: { kind: 'not_found' } as never });
    Object.assign(t.ports, {
      customerStyle: jest
        .fn()
        .mockResolvedValue({ register: 'tu', emojis: false, tone: 'casual' }),
    });
    t.seed(resolved());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).not.toHaveBeenCalled();
    expect(t.ports.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ to: SENDER, bodyParameters: ['06700'] }),
    );
  });
});
