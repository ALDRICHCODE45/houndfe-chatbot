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

  it('resolved inside both windows without a resume capability: sends the current text and ACKs PROVIDER_ACCEPTED', async () => {
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

describe('DeliveryZoneNotifier while the conversation is HUMAN (S7)', () => {
  const withMode = (isHumanMode: () => Promise<boolean>) => {
    const t = setup();
    const ports = { ...t.ports, isHumanMode: jest.fn(isHumanMode) };
    const notifier = new DeliveryZoneNotifier(
      t.store,
      ports,
      PHONE_ID,
      () => new Date(INSIDE),
      () => ATTEMPT,
    );
    return { ...t, ports, notifier };
  };
  const resolvedRow = () =>
    row({
      status: 'RESOLVED',
      resolution: resolution(),
      applyBefore: APPLY_BEFORE,
    });

  it.each([
    ['HUMAN', () => Promise.resolve(true)],
    ['an unreadable mode', () => Promise.reject(new Error('db down'))],
  ])(
    '%s: no send, the row stays RESOLVED (retried on a later tick), moved to the back',
    async (_label, isHumanMode) => {
      const t = withMode(isHumanMode);
      t.seed(resolvedRow());
      await t.notifier.process(resolvedRow());
      expect(t.ports.isHumanMode).toHaveBeenCalledWith(SENDER);
      expect(t.ports.sendText).not.toHaveBeenCalled();
      expect(t.ports.sendTemplate).not.toHaveBeenCalled();
      expect(t.ports.recordRestockApplicationOutcome).not.toHaveBeenCalled();
      expect(t.stored()).toMatchObject({
        status: 'RESOLVED',
        attemptId: null,
        deliveryOutcome: null,
        lastPolledAt: INSIDE,
      });
    },
  );

  it('BOT: sends and is notified as before', async () => {
    const t = withMode(() => Promise.resolve(false));
    t.seed(resolvedRow());
    await t.notifier.process(resolvedRow());
    expect(t.ports.sendText).toHaveBeenCalledTimes(1);
    expect(t.stored().deliveryOutcome).toBe('PROVIDER_ACCEPTED');
  });
});

describe('DeliveryZoneNotifier checkout resume (S4)', () => {
  const resolvedRow = (
    zoneType: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED' = 'FREE',
  ) =>
    row({
      status: 'RESOLVED',
      resolution: resolution({ zoneType }),
      applyBefore: APPLY_BEFORE,
    });
  const OLD =
    '¡Listo! Ya tenemos entrega a su código postal 06700. Pídame de nuevo el envío y le muestro el costo actualizado.';
  const SUMMARY =
    'Resumen de su pedido:\n• Ibuprofeno\nTotal a pagar: $30.00 MXN';
  const BUTTONS = [
    { id: 'order_confirm:ref-1', title: '✅ Confirmar pedido' },
    { id: 'order_change', title: '✏️ Cambiar algo' },
  ];
  const NOTICE =
    '¡Listo! Ya tenemos entrega a su código postal 06700: el envío no tiene costo y llega en aproximadamente 2 días hábiles.';

  function withResume(
    options: {
      now?: string;
      latest?: CustomerInboundObservationLatest;
      resume?: 'ok' | 'null' | 'throws';
    } = {},
  ) {
    const t = setup(options);
    const events: string[] = [];
    const arm = jest.fn(() => void events.push('arm'));
    const discard = jest.fn(() => void events.push('discard'));
    const statusAtPrepare: string[] = [];
    const resumeCheckout = jest.fn(async () => {
      statusAtPrepare.push(t.stored().status);
      events.push('prepare');
      if (options.resume === 'throws') throw new Error('boom');
      if (options.resume === 'null') return null;
      return {
        shippingSentence:
          'el envío no tiene costo y llega en aproximadamente 2 días hábiles',
        summary: {
          text: SUMMARY,
          buttons: BUTTONS,
          prompt: '¿Confirma su pedido?',
        },
        arm,
        discard,
      };
    });
    const sendInteractive = jest.fn(async () => {
      events.push('interactive');
      return {
        providerMessageId: 'wamid.sum',
        providerMessageIds: ['wamid.sum'],
      };
    });
    t.ports.sendText.mockImplementation(() => {
      events.push('text');
      return Promise.resolve({ providerMessageId: 'wamid.text' });
    });
    Object.assign(t.ports, { resumeCheckout, sendInteractive });
    return {
      ...t,
      resumeCheckout,
      sendInteractive,
      arm,
      discard,
      events,
      statusAtPrepare,
    };
  }

  it('FREE: sends the resumed notice, then the summary with the confirm buttons, then arms it', async () => {
    const t = withResume();
    t.seed(resolvedRow('FREE'));
    await t.notifier.process(t.stored());
    expect(t.resumeCheckout).toHaveBeenCalledWith({
      senderId: SENDER,
      zipCode: '06700',
      zoneType: 'FREE',
      sourceRequestId: SOURCE,
      receivingPhoneNumberId: PHONE_ID,
    });
    expect(t.ports.sendText).toHaveBeenCalledTimes(1);
    expect(t.ports.sendText).toHaveBeenCalledWith({ to: SENDER, text: NOTICE });
    expect(t.sendInteractive).toHaveBeenCalledWith({
      to: SENDER,
      body: SUMMARY,
      interactive: { type: 'buttons', buttons: BUTTONS },
      shortBody: '¿Confirma su pedido?',
    });
    expect(t.events).toEqual(['prepare', 'text', 'interactive', 'arm']);
    expect(t.discard).not.toHaveBeenCalled();
    expect(t.ports.recordRestockApplicationOutcome).toHaveBeenCalledWith(
      REQUESTER,
      expect.objectContaining({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.text',
      }),
    );
    expect(t.stored()).toMatchObject({ status: 'CLOSED', channel: 'TEXT' });
  });

  it('SURCHARGE resumes too', async () => {
    const t = withResume();
    t.seed(resolvedRow('SURCHARGE'));
    await t.notifier.process(t.stored());
    expect(t.resumeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ zoneType: 'SURCHARGE' }),
    );
    expect(t.events).toEqual(['prepare', 'text', 'interactive', 'arm']);
  });

  it('prepares only after the durable SEND_STARTED marker', async () => {
    const t = withResume();
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.statusAtPrepare).toEqual(['SEND_STARTED']);
  });

  it('a tú profile gets the notice, the summary and the button prompt in tú', async () => {
    const t = withResume();
    Object.assign(t.ports, {
      customerStyle: jest
        .fn()
        .mockResolvedValue({ register: 'tu', emojis: false, tone: 'casual' }),
    });
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: '¡Listo! Ya tenemos entrega a tu código postal 06700: el envío no tiene costo y llega en aproximadamente 2 días hábiles.',
    });
    expect(t.sendInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ shortBody: '¿Confirmas tu pedido?' }),
    );
  });

  it.each([
    ['no resume capability', undefined],
    ['a failed precondition', 'null'],
    ['a throwing resume', 'throws'],
  ] as const)(
    '%s: sends the current notice text and no summary',
    async (_label, resume) => {
      const t = resume === undefined ? setup() : withResume({ resume });
      t.seed(resolvedRow());
      await t.notifier.process(t.stored());
      expect(t.ports.sendText).toHaveBeenCalledTimes(1);
      expect(t.ports.sendText).toHaveBeenCalledWith({ to: SENDER, text: OLD });
      if ('sendInteractive' in t)
        expect(t.sendInteractive).not.toHaveBeenCalled();
      expect(t.stored()).toMatchObject({
        status: 'CLOSED',
        deliveryOutcome: 'PROVIDER_ACCEPTED',
      });
    },
  );

  it.each(['CARRIER_ONLY', 'DENIED'] as const)(
    '%s keeps the current behaviour: no resume',
    async (zoneType) => {
      const t = withResume();
      t.seed(resolvedRow(zoneType));
      await t.notifier.process(t.stored());
      expect(t.resumeCheckout).not.toHaveBeenCalled();
      expect(t.sendInteractive).not.toHaveBeenCalled();
      expect(t.ports.sendText).toHaveBeenCalledTimes(1);
    },
  );

  it('outside the 24 h window the template goes out and nothing is resumed', async () => {
    const t = withResume({ latest: inbound('2026-11-04T10:00:00.000Z') });
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.resumeCheckout).not.toHaveBeenCalled();
    expect(t.sendInteractive).not.toHaveBeenCalled();
    expect(t.ports.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('a redelivery of the same row sends the notice and the summary once', async () => {
    const t = withResume();
    t.seed(resolvedRow());
    const stale = t.stored();
    await t.notifier.process(stale);
    await t.notifier.process(stale);
    await t.notifier.process(t.stored());
    expect(t.resumeCheckout).toHaveBeenCalledTimes(1);
    expect(t.ports.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendInteractive).toHaveBeenCalledTimes(1);
    expect(t.arm).toHaveBeenCalledTimes(1);
  });

  it('a row found in SEND_STARTED (crash) sends and resumes nothing', async () => {
    const t = withResume();
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
    expect(t.resumeCheckout).not.toHaveBeenCalled();
    expect(t.ports.sendText).not.toHaveBeenCalled();
    expect(t.sendInteractive).not.toHaveBeenCalled();
  });

  it('a conversation in HUMAN mode gets neither notice nor resume', async () => {
    const t = withResume();
    Object.assign(t.ports, { isHumanMode: jest.fn().mockResolvedValue(true) });
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.resumeCheckout).not.toHaveBeenCalled();
    expect(t.ports.sendText).not.toHaveBeenCalled();
  });

  it('the conversation turns HUMAN between the notice and the summary: no summary, pending dropped', async () => {
    const t = withResume();
    Object.assign(t.ports, {
      isHumanMode: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
    });
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenCalledWith({ to: SENDER, text: NOTICE });
    expect(t.sendInteractive).not.toHaveBeenCalled();
    expect(t.arm).not.toHaveBeenCalled();
    expect(t.discard).toHaveBeenCalledTimes(1);
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      deliveryOutcome: 'PROVIDER_ACCEPTED',
    });
  });

  it('a failed notice send sends no summary and drops the pending one', async () => {
    const t = withResume();
    t.ports.sendText.mockRejectedValue(new Error('provider down'));
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.sendInteractive).not.toHaveBeenCalled();
    expect(t.arm).not.toHaveBeenCalled();
    expect(t.discard).toHaveBeenCalledTimes(1);
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      deliveryOutcome: 'DELIVERY_UNKNOWN',
    });
  });

  it('an interactive failure falls back to the summary as plain text and still arms it', async () => {
    const t = withResume();
    t.sendInteractive.mockRejectedValue(new Error('no buttons'));
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenNthCalledWith(2, {
      to: SENDER,
      text: SUMMARY,
    });
    expect(t.arm).toHaveBeenCalledTimes(1);
    expect(t.discard).not.toHaveBeenCalled();
  });

  it('a sender without interactive support sends the summary as plain text', async () => {
    const t = withResume();
    delete (t.ports as { sendInteractive?: unknown }).sendInteractive;
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.ports.sendText).toHaveBeenNthCalledWith(2, {
      to: SENDER,
      text: SUMMARY,
    });
    expect(t.arm).toHaveBeenCalledTimes(1);
  });

  it('a summary that cannot be sent at all is dropped, never armed, and the notice outcome stands', async () => {
    const t = withResume();
    t.sendInteractive.mockRejectedValue(new Error('no buttons'));
    t.ports.sendText
      .mockResolvedValueOnce({ providerMessageId: 'wamid.text' })
      .mockRejectedValueOnce(new Error('down'));
    t.seed(resolvedRow());
    await t.notifier.process(t.stored());
    expect(t.arm).not.toHaveBeenCalled();
    expect(t.discard).toHaveBeenCalledTimes(1);
    expect(t.stored()).toMatchObject({
      status: 'CLOSED',
      deliveryOutcome: 'PROVIDER_ACCEPTED',
      providerMessageId: 'wamid.text',
    });
  });
});
