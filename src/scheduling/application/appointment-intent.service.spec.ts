import { Logger } from '@nestjs/common';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { SchedulingClient } from '../../chatbot-api/domain/scheduling.port';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { CancelHumanRequestResult } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { GetConversationStateResult } from '../../chatbot-api/domain/dtos/live-conversation.dto';
import type {
  ListSlotsResult,
  RescheduleRequestResult,
} from '../../chatbot-api/domain/dtos/scheduling.dto';
import type {
  SchedulingAppointment,
  SchedulingOffer,
} from '../../conversation/domain/scheduling-state';
import { OFFER_TTL_MS } from '../../conversation/domain/scheduling-state';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  cancelledText,
  notUnderstoodText,
  rescheduleOfferText,
  rescheduledText,
  slotTakenText,
  whatTimeText,
} from '../domain/scheduling-copy';
import { formatWhen, slotLabel } from '../domain/slot-time';
import { AppointmentIntentService } from './appointment-intent.service';
import { SchedulingStateService } from './scheduling-state.service';

const SENDER = '5215550001111';
const ZONE = 'America/Mexico_City';
const NOW = new Date('2026-11-12T20:00:00.000Z'); // Thu 14:00 in Mexico City
const INBOUND = '2026-11-12T19:59:30.000Z';
const NEXT_OPEN = '2026-11-13T15:00:00.000Z';
const BOOKED_AT = '2026-11-13T17:00:00.000Z'; // Fri 11:00
const SLOT_1 = '2026-11-13T15:00:00.000Z';
const SLOT_2 = '2026-11-13T15:30:00.000Z';
const SLOT_3 = '2026-11-13T16:00:00.000Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const APPOINTMENT: SchedulingAppointment = {
  requestId: 'req-77',
  subtype: 'TALK_TO_HUMAN',
  scheduledFor: BOOKED_AT,
  scheduleVersion: 1,
  timeZone: ZONE,
  rescheduleCount: 0,
};

const THREE = [
  { startsAt: SLOT_1, withinWindow: true },
  { startsAt: SLOT_2, withinWindow: true },
  { startsAt: SLOT_3, withinWindow: false },
];

const slotsOk = (
  slots = THREE,
  nextOpenAt: string | null = NEXT_OPEN,
  openNow = false,
): ListSlotsResult => ({
  kind: 'ok',
  timeZone: ZONE,
  whatsappWindowClosesAt: '2026-11-13T19:59:30.000Z',
  businessHours: {
    openNow,
    nextOpenAt,
    timeZone: ZONE,
    weeklyRanges: [],
    closedDates: [],
  },
  slots,
});

const rescheduled = (
  status: 'RESCHEDULED' | 'UNCHANGED' = 'RESCHEDULED',
  scheduledFor = SLOT_2,
  scheduleVersion = 2,
): RescheduleRequestResult => ({
  kind: 'ok',
  status,
  requestId: 'req-77',
  scheduledFor,
  previousScheduledFor: status === 'UNCHANGED' ? null : BOOKED_AT,
  scheduleVersion,
  requiresTemplateAtStart: false,
  whatsappWindowClosesAt: null,
});

const cancelled: CancelHumanRequestResult = {
  kind: 'ok',
  response: {
    id: 'req-77',
    status: 'CANCELLED',
    reason: 'CUSTOMER_WITHDREW',
    cancelledAt: NOW.toISOString(),
  },
};

const stateRoute = (
  scheduledRequest: {
    requestId: string;
    subtype: string;
    scheduledFor: string;
    needsReschedule: boolean;
    scheduleVersion: number;
  } | null,
): GetConversationStateResult => ({
  kind: 'ok',
  mode: 'BOT',
  handoffEpoch: 0,
  sessionState: null,
  requestId: null,
  assigneeFirstName: null,
  scheduledRequest,
});

const label = (iso: string, zone = ZONE) => slotLabel(iso, zone, NOW);

function setup(
  options: {
    appointment?: SchedulingAppointment | null;
    offer?: SchedulingOffer | null;
    route?: GetConversationStateResult;
    slots?: (ListSlotsResult | Error)[];
    reschedule?: (RescheduleRequestResult | Error)[];
    cancel?: (CancelHumanRequestResult | Error)[];
    closeFails?: boolean;
  } = {},
) {
  const store = new InMemoryConversationStore();
  const clock = () => NOW;
  const getConversationState = jest.fn(() =>
    Promise.resolve(options.route ?? stateRoute(null)),
  );
  const state = new SchedulingStateService(
    { store, live: { getConversationState } },
    { clock },
  );
  const next = <T>(queue: (T | Error)[]) => {
    const item = queue.length > 1 ? queue.shift()! : queue[0];
    return item instanceof Error ? Promise.reject(item) : Promise.resolve(item);
  };
  const slotQueue = [...(options.slots ?? [slotsOk()])];
  const listSlots = jest.fn(() => next(slotQueue));
  const rescheduleQueue = [...(options.reschedule ?? [rescheduled()])];
  const rescheduleRequest = jest.fn<
    ReturnType<SchedulingClient['rescheduleRequest']>,
    Parameters<SchedulingClient['rescheduleRequest']>
  >(() => next(rescheduleQueue));
  const cancelQueue = [...(options.cancel ?? [cancelled])];
  const cancelHumanRequest = jest.fn<
    ReturnType<HumanRequestsClient['cancelHumanRequest']>,
    Parameters<HumanRequestsClient['cancelHumanRequest']>
  >(() => next(cancelQueue));
  const closeRequest = jest.fn(() =>
    options.closeFails
      ? Promise.reject(new Error('registry down'))
      : Promise.resolve(true),
  );
  let seq = 0;
  const service = new AppointmentIntentService(
    {
      scheduling: { listSlots, rescheduleRequest },
      requests: { cancelHumanRequest },
      state,
      registry: { closeRequest },
    },
    {
      clock,
      newKey: () =>
        `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    },
  );
  const ready = (async () => {
    if (options.appointment !== null)
      await state.bookAppointment(SENDER, options.appointment ?? APPOINTMENT);
    if (options.offer) await state.storeOffer(SENDER, options.offer);
  })();
  const handle = async (text: string, messageId = 'wamid.IN1') => {
    await ready;
    return service.handle(
      { senderId: SENDER, text, inboundAt: INBOUND, messageId },
      await state.read(SENDER),
    );
  };
  return {
    service,
    state,
    store,
    handle,
    ready,
    listSlots,
    rescheduleRequest,
    cancelHumanRequest,
    closeRequest,
    getConversationState,
  };
}

const rescheduleOffer = (patch: Partial<SchedulingOffer> = {}) =>
  ({
    slots: THREE,
    timeZone: ZONE,
    offeredAt: NOW.toISOString(),
    subtype: 'TALK_TO_HUMAN',
    sourceRequestId: '11111111-1111-4111-8111-111111111111',
    openWhen: formatWhen(NEXT_OPEN, ZONE, NOW),
    unclearCount: 0,
    rescheduleRequestId: 'req-77',
    ...patch,
  }) as SchedulingOffer;

describe('AppointmentIntentService (T4)', () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
  });
  afterEach(() => {
    for (const line of logged) {
      expect(line).not.toContain(SENDER);
      expect(line).not.toMatch(/wamid\.[A-Za-z0-9]/);
    }
    jest.restoreAllMocks();
  });

  describe('not an appointment message', () => {
    it('plain text with no pending question or reschedule offer: null, with no read, no call and no write', async () => {
      const h = setup();
      await h.ready;
      const commit = jest.spyOn(h.store, 'commitScheduling');
      await expect(h.handle('hola, ¿tienen croquetas?')).resolves.toBeNull();
      expect(h.getConversationState).not.toHaveBeenCalled();
      expect(h.listSlots).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });

    it('a booking offer (not a reschedule one) is left to the booking policy', async () => {
      const h = setup({
        offer: rescheduleOffer({ rescheduleRequestId: undefined }),
      });
      await expect(h.handle('1')).resolves.toBeNull();
      expect(h.rescheduleRequest).not.toHaveBeenCalled();
    });
  });

  describe('"¿a qué hora quedé?"', () => {
    it('answers the approved text from the local appointment, with no backend call', async () => {
      const h = setup();
      await expect(h.handle('¿a qué hora quedé?')).resolves.toEqual({
        kind: 'reply',
        text: whatTimeText(label(BOOKED_AT)),
      });
      expect(h.getConversationState).not.toHaveBeenCalled();
      expect(h.listSlots).not.toHaveBeenCalled();
    });

    it('"¿cuándo es mi cita?" is the same answer', async () => {
      const h = setup();
      await expect(h.handle('¿Cuándo es mi cita?')).resolves.toEqual({
        kind: 'reply',
        text: whatTimeText(label(BOOKED_AT)),
      });
    });

    it('with no local appointment it recovers once from the state route', async () => {
      const h = setup({
        appointment: null,
        route: stateRoute({
          requestId: 'req-77',
          subtype: 'TALK_TO_HUMAN',
          scheduledFor: BOOKED_AT,
          needsReschedule: false,
          scheduleVersion: 4,
        }),
        slots: [slotsOk()],
      });
      const outcome = await h.handle('a que hora quede');
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
      // The recovered appointment has no zone: one slots read gives it.
      expect(h.listSlots).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({
        kind: 'reply',
        text: whatTimeText(label(BOOKED_AT)),
      });
      expect((await h.state.read(SENDER)).appointment).toMatchObject({
        requestId: 'req-77',
        scheduleVersion: 4,
        timeZone: ZONE,
      });
      // The zone is now known: the next ask makes no call at all.
      await h.handle('a que hora quede');
      expect(h.listSlots).toHaveBeenCalledTimes(1);
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a failing slots read', [new Error('boom')]],
      ['SCHEDULING_DISABLED', [{ kind: 'SCHEDULING_DISABLED' as const }]],
      [
        'a refused slots read',
        [
          {
            kind: 'RETRYABLE' as const,
            cause: 'timeout' as const,
            status: null,
            retryAfterSeconds: null,
          },
        ],
      ],
    ])(
      'an unknown zone with %s defaults to America/Mexico_City',
      async (_name, slots) => {
        const h = setup({
          appointment: { ...APPOINTMENT, timeZone: null },
          slots: slots,
        });
        await expect(h.handle('¿a qué hora quedé?')).resolves.toEqual({
          kind: 'reply',
          text: whatTimeText(label(BOOKED_AT, 'America/Mexico_City')),
        });
        expect(h.listSlots).toHaveBeenCalledTimes(1);
      },
    );

    it('no appointment anywhere: null (the agent answers)', async () => {
      const h = setup({ appointment: null });
      await expect(h.handle('¿a qué hora quedé?')).resolves.toBeNull();
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
    });

    it('an appointment whose time already passed is not announced', async () => {
      const h = setup({
        appointment: {
          ...APPOINTMENT,
          scheduledFor: '2026-11-12T15:00:00.000Z',
        },
      });
      await expect(h.handle('¿a qué hora quedé?')).resolves.toEqual({
        kind: 'pass',
      });
    });
  });

  describe('change the appointment', () => {
    it('offers the free slots with the approved reschedule offer text (not the out-of-hours one) and stores a reschedule offer with its own key', async () => {
      const h = setup();
      const outcome = await h.handle('quiero cambiar mi cita');
      expect(h.listSlots).toHaveBeenCalledWith({
        conversationRef: conversationRefFor(SENDER),
        lastCustomerMessageAt: INBOUND,
      });
      expect(outcome).toEqual({
        kind: 'reply',
        text: rescheduleOfferText(THREE.map((slot) => label(slot.startsAt))),
      });
      const { offer } = await h.state.read(SENDER);
      expect(offer).toMatchObject({
        slots: THREE,
        timeZone: ZONE,
        subtype: 'TALK_TO_HUMAN',
        rescheduleRequestId: 'req-77',
        unclearCount: 0,
      });
      expect(offer?.sourceRequestId).toMatch(UUID);
    });

    it('without nextOpenAt the {cuándo} is the first offered slot', async () => {
      const h = setup({ slots: [slotsOk(THREE, null)] });
      const outcome = await h.handle('¿la puedo mover?');
      expect(outcome).toEqual({
        kind: 'reply',
        text: rescheduleOfferText(THREE.map((slot) => label(slot.startsAt))),
      });
    });

    it('with no local appointment it recovers one from the state route first', async () => {
      const h = setup({
        appointment: null,
        route: stateRoute({
          requestId: 'req-77',
          subtype: 'COMPLAINT',
          scheduledFor: BOOKED_AT,
          needsReschedule: false,
          scheduleVersion: 2,
        }),
      });
      await h.handle('quiero cambiar mi cita');
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
      expect((await h.state.read(SENDER)).offer).toMatchObject({
        rescheduleRequestId: 'req-77',
        subtype: 'COMPLAINT',
      });
    });

    it('three reschedules is the cap: no offer, the agent answers', async () => {
      const h = setup({ appointment: { ...APPOINTMENT, rescheduleCount: 3 } });
      await expect(h.handle('quiero cambiar mi cita')).resolves.toEqual({
        kind: 'pass',
      });
      expect(h.listSlots).not.toHaveBeenCalled();
      expect((await h.state.read(SENDER)).offer).toBeNull();
    });

    it('the cap is per conversation: three used reschedules block a different (re)booked appointment (F5)', async () => {
      const h = setup();
      await h.ready;
      await h.store.commitScheduling(
        SENDER,
        (await h.store.getScheduling(SENDER)).raw,
        {
          offer: null,
          appointment: {
            ...APPOINTMENT,
            requestId: 'req-88',
            rescheduleCount: 0,
          },
          rescheduleCount: 3,
        },
        NOW.toISOString(),
      );
      await expect(h.handle('quiero cambiar mi cita')).resolves.toEqual({
        kind: 'pass',
      });
      expect(h.listSlots).not.toHaveBeenCalled();
    });

    it('two reschedules is still allowed', async () => {
      const h = setup({ appointment: { ...APPOINTMENT, rescheduleCount: 2 } });
      const outcome = await h.handle('quiero cambiar mi cita');
      expect(outcome).toMatchObject({ kind: 'reply' });
    });

    it.each([
      ['SCHEDULING_DISABLED', [{ kind: 'SCHEDULING_DISABLED' as const }]],
      ['a throwing read', [new Error('boom')]],
      ['no free slot', [slotsOk([])]],
      [
        'a retryable failure',
        [
          {
            kind: 'RETRYABLE' as const,
            cause: 'network' as const,
            status: null,
            retryAfterSeconds: null,
          },
        ],
      ],
    ])('%s: no offer, no unapproved text', async (_name, slots) => {
      const h = setup({ slots: slots });
      await expect(h.handle('quiero cambiar mi cita')).resolves.toEqual({
        kind: 'pass',
      });
      expect((await h.state.read(SENDER)).offer).toBeNull();
    });

    it('more than 3 slots from the API are cut to 3 before the offer is stored', async () => {
      const four = [
        ...THREE,
        { startsAt: '2026-11-13T16:30:00.000Z', withinWindow: false },
      ];
      const h = setup({ slots: [slotsOk(four)] });
      const outcome = await h.handle('quiero cambiar mi cita');
      expect(outcome).toMatchObject({ kind: 'reply' });
      expect((await h.state.read(SENDER)).offer?.slots).toHaveLength(3);
    });

    describe('"sí" right after «¿Quiere cambiarla?»', () => {
      const asked = (at = NOW) => ({
        ...APPOINTMENT,
        changeAskedAt: at.toISOString(),
      });

      it('starts the change and drops the question flag', async () => {
        const h = setup({ appointment: asked() });
        const outcome = await h.handle('sí');
        expect(outcome).toMatchObject({ kind: 'reply' });
        expect(h.listSlots).toHaveBeenCalledTimes(1);
        const { appointment, offer } = await h.state.read(SENDER);
        expect(offer?.rescheduleRequestId).toBe('req-77');
        expect(appointment).not.toHaveProperty('changeAskedAt');
      });

      it('"no" or any other text drops the flag and goes on (a later "sí" is not a change)', async () => {
        for (const text of ['no', 'hola', '¿a qué hora quedé?']) {
          const h = setup({ appointment: asked() });
          const outcome = await h.handle(text);
          expect(h.listSlots).not.toHaveBeenCalled();
          expect((await h.state.read(SENDER)).appointment).not.toHaveProperty(
            'changeAskedAt',
          );
          if (text !== '¿a qué hora quedé?') expect(outcome).toBeNull();
        }
      });

      it('a question older than 10 minutes is no question: "sí" goes to the agent', async () => {
        const h = setup({
          appointment: asked(new Date(NOW.getTime() - 10 * 60_000 - 1)),
        });
        await expect(h.handle('sí')).resolves.toBeNull();
        expect(h.listSlots).not.toHaveBeenCalled();
      });

      it('a plain "sí" with no question asked is never a change', async () => {
        const h = setup();
        await expect(h.handle('sí')).resolves.toBeNull();
      });

      it('at the cap the confirmation falls through to the agent', async () => {
        const h = setup({
          appointment: { ...asked(), rescheduleCount: 3 },
        });
        await expect(h.handle('sí')).resolves.toEqual({ kind: 'pass' });
      });
    });
  });

  describe('the choice of a new slot', () => {
    it('RESCHEDULED: books with the offer key, updates the appointment (+1) and says rescheduledText', async () => {
      const h = setup({ offer: rescheduleOffer() });
      const outcome = await h.handle('2', 'wamid.CHOICE');
      expect(h.rescheduleRequest).toHaveBeenCalledTimes(1);
      expect(h.rescheduleRequest).toHaveBeenCalledWith(
        'req-77',
        {
          scheduledFor: SLOT_2,
          lastCustomerMessageAt: INBOUND,
          triggerWaMessageId: 'wamid.CHOICE',
        },
        '11111111-1111-4111-8111-111111111111',
      );
      expect(outcome).toEqual({
        kind: 'reply',
        text: rescheduledText(label(SLOT_2)),
      });
      await expect(h.state.read(SENDER)).resolves.toEqual({
        offer: null,
        appointment: {
          ...APPOINTMENT,
          scheduledFor: SLOT_2,
          scheduleVersion: 2,
          rescheduleCount: 1,
        },
        rescheduleCount: 1,
      });
    });

    it('UNCHANGED: the same text, no count', async () => {
      const h = setup({
        offer: rescheduleOffer(),
        reschedule: [rescheduled('UNCHANGED', BOOKED_AT, 1)],
      });
      const outcome = await h.handle('1');
      expect(outcome).toEqual({
        kind: 'reply',
        text: rescheduledText(label(BOOKED_AT)),
      });
      const { appointment, offer } = await h.state.read(SENDER);
      expect(appointment?.rescheduleCount).toBe(0);
      expect(offer).toBeNull();
    });

    it('SLOT_UNAVAILABLE: re-offers the fresh list under a new key, still a reschedule offer', async () => {
      const fresh = [
        { startsAt: SLOT_2, withinWindow: true },
        { startsAt: SLOT_3, withinWindow: false },
      ];
      const h = setup({
        offer: rescheduleOffer(),
        reschedule: [
          {
            kind: 'SLOT_UNAVAILABLE',
            slots: fresh,
            timeZone: ZONE,
            whatsappWindowClosesAt: '2026-11-13T19:59:30.000Z',
          },
        ],
      });
      const outcome = await h.handle('1');
      expect(outcome).toEqual({
        kind: 'reply',
        text: slotTakenText(fresh.map((slot) => label(slot.startsAt))),
      });
      const { offer } = await h.state.read(SENDER);
      expect(offer).toMatchObject({
        slots: fresh,
        rescheduleRequestId: 'req-77',
        unclearCount: 0,
      });
      expect(offer?.sourceRequestId).toMatch(UUID);
      expect(offer?.sourceRequestId).not.toBe(
        '11111111-1111-4111-8111-111111111111',
      );
    });

    it('SLOT_UNAVAILABLE with more than 3 fresh slots stores 3', async () => {
      const fresh = [
        ...THREE,
        { startsAt: '2026-11-13T16:30:00.000Z', withinWindow: false },
      ];
      const h = setup({
        offer: rescheduleOffer(),
        reschedule: [
          {
            kind: 'SLOT_UNAVAILABLE',
            slots: fresh,
            timeZone: ZONE,
            whatsappWindowClosesAt: '2026-11-13T19:59:30.000Z',
          },
        ],
      });
      await expect(h.handle('1')).resolves.toMatchObject({ kind: 'reply' });
      expect((await h.state.read(SENDER)).offer?.slots).toHaveLength(3);
    });

    it('SLOT_UNAVAILABLE with nothing free: the offer is dropped and the agent answers', async () => {
      const h = setup({
        offer: rescheduleOffer(),
        reschedule: [
          {
            kind: 'SLOT_UNAVAILABLE',
            slots: [],
            timeZone: ZONE,
            whatsappWindowClosesAt: '2026-11-13T19:59:30.000Z',
          },
        ],
      });
      await expect(h.handle('1')).resolves.toEqual({ kind: 'pass' });
      const { offer, appointment } = await h.state.read(SENDER);
      expect(offer).toBeNull();
      expect(appointment).toEqual(APPOINTMENT);
    });

    it.each([['REQUEST_CLOSED'], ['NOT_SCHEDULED'], ['NOT_FOUND']])(
      '%s: the appointment and the offer are cleared and the agent answers',
      async (kind) => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [{ kind } as RescheduleRequestResult],
        });
        await expect(h.handle('1')).resolves.toEqual({ kind: 'pass' });
        await expect(h.state.read(SENDER)).resolves.toEqual({
          offer: null,
          appointment: null,
        });
      },
    );

    it('RESCHEDULE_NOT_ALLOWED (a live session started): the offer is dropped silently, the appointment is kept', async () => {
      const h = setup({
        offer: rescheduleOffer(),
        reschedule: [{ kind: 'RESCHEDULE_NOT_ALLOWED' }],
      });
      await expect(h.handle('1')).resolves.toEqual({ kind: 'pass' });
      await expect(h.state.read(SENDER)).resolves.toEqual({
        offer: null,
        appointment: APPOINTMENT,
      });
    });

    it.each([['SCHEDULING_DISABLED']])(
      '%s: the offer is dropped, nothing is promised',
      async (kind) => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [{ kind } as RescheduleRequestResult],
        });
        await expect(h.handle('1')).resolves.toEqual({ kind: 'pass' });
        const { offer, appointment } = await h.state.read(SENDER);
        expect(offer).toBeNull();
        expect(appointment).toEqual(APPOINTMENT);
      },
    );

    describe('IDEMPOTENCY_CONFLICT after an uncertain send (F2)', () => {
      const conflict: RescheduleRequestResult = {
        kind: 'IDEMPOTENCY_CONFLICT',
      };
      const route = (
        scheduledFor: string,
        scheduleVersion = 2,
        id = 'req-77',
      ) =>
        stateRoute({
          requestId: id,
          subtype: 'TALK_TO_HUMAN',
          scheduledFor,
          needsReschedule: false,
          scheduleVersion,
        });
      const keys = (h: ReturnType<typeof setup>) =>
        h.rescheduleRequest.mock.calls.map((call) => call[2]);

      it('the backend already holds the chosen slot: it is stored and answered as rescheduled', async () => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [conflict],
          route: route(SLOT_2),
        });
        await expect(h.handle('2')).resolves.toEqual({
          kind: 'reply',
          text: rescheduledText(label(SLOT_2)),
        });
        expect(h.rescheduleRequest).toHaveBeenCalledTimes(1);
        const state = await h.state.read(SENDER);
        expect(state.offer).toBeNull();
        expect(state.appointment).toMatchObject({
          requestId: 'req-77',
          scheduledFor: SLOT_2,
          scheduleVersion: 2,
          rescheduleCount: 1,
        });
        expect(state.rescheduleCount).toBe(1);
      });

      it('the backend holds ANOTHER newer time (an earlier choice committed): stored, answered with the what-time text, offer dropped', async () => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [conflict],
          route: route(SLOT_3),
        });
        await expect(h.handle('1')).resolves.toEqual({
          kind: 'reply',
          text: whatTimeText(label(SLOT_3)),
        });
        expect(h.rescheduleRequest).toHaveBeenCalledTimes(1);
        const state = await h.state.read(SENDER);
        expect(state.offer).toBeNull();
        expect(state.appointment).toMatchObject({
          scheduledFor: SLOT_3,
          scheduleVersion: 2,
        });
      });

      it.each([
        ['no scheduled request', stateRoute(null)],
        ['another request', route(SLOT_2, 2, 'req-other')],
        ['nothing newer than the local appointment', route(BOOKED_AT, 1)],
      ])(
        '%s: a fresh key is stored first and the choice retried once',
        async (_name, answer) => {
          const h = setup({
            offer: rescheduleOffer(),
            reschedule: [conflict, rescheduled()],
            route: answer,
          });
          await expect(h.handle('2')).resolves.toEqual({
            kind: 'reply',
            text: rescheduledText(label(SLOT_2)),
          });
          const [first, second] = keys(h);
          expect(first).toBe('11111111-1111-4111-8111-111111111111');
          expect(second).toMatch(UUID);
          expect(second).not.toBe(first);
          const state = await h.state.read(SENDER);
          expect(state.offer).toBeNull();
          expect(state.appointment).toMatchObject({
            scheduledFor: SLOT_2,
            rescheduleCount: 1,
          });
        },
      );

      it('the fresh key is stored BEFORE the retry', async () => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [conflict, new Error('network')],
          route: stateRoute(null),
        });
        await expect(h.handle('2')).resolves.toEqual({ kind: 'pass' });
        const { offer } = await h.state.read(SENDER);
        expect(offer?.sourceRequestId).toBe(keys(h)[1]);
        expect(offer?.sourceRequestId).not.toBe(
          '11111111-1111-4111-8111-111111111111',
        );
        expect(offer?.rescheduleRequestId).toBe('req-77');
      });

      it('a failing recovery read also rotates the key', async () => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [conflict, rescheduled()],
        });
        h.getConversationState.mockRejectedValue(new Error('down'));
        await expect(h.handle('2')).resolves.toMatchObject({ kind: 'reply' });
        expect(h.rescheduleRequest).toHaveBeenCalledTimes(2);
      });

      it('a second conflict on the fresh key drops the offer (the appointment is kept) and the agent answers', async () => {
        const h = setup({
          offer: rescheduleOffer(),
          reschedule: [conflict],
          route: stateRoute(null),
        });
        await expect(h.handle('2')).resolves.toEqual({ kind: 'pass' });
        expect(h.rescheduleRequest).toHaveBeenCalledTimes(2);
        const state = await h.state.read(SENDER);
        expect(state.offer).toBeNull();
        expect(state.appointment).toEqual(APPOINTMENT);
      });
    });

    it('a transient failure keeps the offer and its key so the retry reuses it', async () => {
      const h = setup({
        offer: rescheduleOffer(),
        reschedule: [
          {
            kind: 'RETRYABLE',
            cause: 'timeout',
            status: null,
            retryAfterSeconds: null,
          },
          new Error('network'),
          rescheduled(),
        ],
      });
      await expect(h.handle('2')).resolves.toEqual({ kind: 'pass' });
      await expect(h.handle('2')).resolves.toEqual({ kind: 'pass' });
      await expect(h.handle('2')).resolves.toMatchObject({ kind: 'reply' });
      const keys = h.rescheduleRequest.mock.calls.map((call) => call[2]);
      expect(new Set(keys)).toEqual(
        new Set(['11111111-1111-4111-8111-111111111111']),
      );
    });

    it('a not-understood choice answers the approved text and counts; the second drops the offer', async () => {
      const h = setup({ offer: rescheduleOffer() });
      await expect(h.handle('el que sea')).resolves.toEqual({
        kind: 'reply',
        text: notUnderstoodText(),
      });
      expect((await h.state.read(SENDER)).offer?.unclearCount).toBe(1);
      await expect(h.handle('no sé')).resolves.toEqual({ kind: 'pass' });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      expect(h.rescheduleRequest).not.toHaveBeenCalled();
    });

    it('an expired offer is dropped and the agent answers', async () => {
      const h = setup({
        offer: rescheduleOffer({
          offeredAt: new Date(NOW.getTime() - OFFER_TTL_MS).toISOString(),
        }),
      });
      await expect(h.handle('1')).resolves.toEqual({ kind: 'pass' });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      expect(h.rescheduleRequest).not.toHaveBeenCalled();
    });

    it('an offer whose appointment is gone (cancelled meanwhile) is dropped without a call', async () => {
      const h = setup({
        appointment: { ...APPOINTMENT, requestId: 'req-OTHER' },
        offer: rescheduleOffer(),
      });
      await expect(h.handle('1')).resolves.toEqual({ kind: 'pass' });
      expect(h.rescheduleRequest).not.toHaveBeenCalled();
      expect((await h.state.read(SENDER)).offer).toBeNull();
    });

    it('a success whose local write fails still tells the customer (and drops the stale appointment best-effort)', async () => {
      const h = setup({ offer: rescheduleOffer() });
      await h.ready;
      jest
        .spyOn(h.state, 'recordCustomerReschedule')
        .mockRejectedValue(new Error('db down'));
      await expect(h.handle('2')).resolves.toEqual({
        kind: 'reply',
        text: rescheduledText(label(SLOT_2)),
      });
      expect((await h.state.read(SENDER)).appointment).toBeNull();
    });

    it('the time questions are answered while an offer is open (the offer stays)', async () => {
      const h = setup({ offer: rescheduleOffer() });
      await expect(h.handle('¿a qué hora quedé?')).resolves.toEqual({
        kind: 'reply',
        text: whatTimeText(label(BOOKED_AT)),
      });
      expect((await h.state.read(SENDER)).offer).not.toBeNull();
    });
  });

  describe('cancel the appointment', () => {
    it('cancels through the request cancel route with a stable UUID key, clears the appointment and says cancelledText', async () => {
      const h = setup();
      const outcome = await h.handle('cancela mi cita', 'wamid.CANCEL1');
      expect(h.cancelHumanRequest).toHaveBeenCalledTimes(1);
      expect(h.cancelHumanRequest).toHaveBeenCalledWith(
        'req-77',
        { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.CANCEL1' },
        expect.stringMatching(UUID),
      );
      expect(outcome).toEqual({ kind: 'reply', text: cancelledText() });
      await expect(h.state.read(SENDER)).resolves.toEqual({
        offer: null,
        appointment: null,
      });
      expect(h.closeRequest).toHaveBeenCalledWith('req-77', 'CANCELLED');
    });

    it('the same message redelivered uses the same key; another message another key', async () => {
      const a = setup({ cancel: [new Error('net'), cancelled] });
      await a.handle('cancela mi cita', 'wamid.X');
      await a.handle('cancela mi cita', 'wamid.X');
      await a.handle('cancela mi cita', 'wamid.Y');
      const keys = a.cancelHumanRequest.mock.calls.map((call) => call[2]);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it('a bare "ya no voy a poder" is ambiguous: no cancel call, the message goes on (F4)', async () => {
      const h = setup();
      await expect(h.handle('ya no voy a poder')).resolves.toBeNull();
      await expect(h.handle('ya no puedo ir')).resolves.toBeNull();
      expect(h.cancelHumanRequest).not.toHaveBeenCalled();
      expect((await h.state.read(SENDER)).appointment).not.toBeNull();
    });

    it('"ya no voy a poder ir a la cita" cancels too, and a reschedule offer of that request goes with it', async () => {
      const h = setup({ offer: rescheduleOffer() });
      await expect(h.handle('ya no voy a poder ir a la cita')).resolves.toEqual(
        {
          kind: 'reply',
          text: cancelledText(),
        },
      );
      await expect(h.state.read(SENDER)).resolves.toEqual({
        offer: null,
        appointment: null,
      });
    });

    it('with no appointment anywhere nothing is cancelled and the message goes on', async () => {
      const h = setup({ appointment: null });
      await expect(h.handle('cancela mi cita')).resolves.toBeNull();
      expect(h.cancelHumanRequest).not.toHaveBeenCalled();
    });

    it.each([
      ['REQUEST_CLOSED', 'pass', true],
      ['NOT_FOUND', 'pass', true],
      ['ALREADY_RESOLVED', 'pass', true],
      ['CANCEL_NOT_ALLOWED', 'pass', false],
      ['IDEMPOTENCY_CONFLICT', 'pass', false],
      ['RATE_LIMITED', 'pass', false],
    ])(
      '%s: no cancelled text; appointment cleared: %s',
      async (kind, _outcome, clears) => {
        const h = setup({
          cancel: [
            kind === 'ALREADY_RESOLVED'
              ? { kind, resolution: null }
              : kind === 'RATE_LIMITED'
                ? { kind, retryAfterSeconds: 3 }
                : ({ kind } as CancelHumanRequestResult),
          ],
        });
        await expect(h.handle('cancela mi cita')).resolves.toEqual({
          kind: 'pass',
        });
        expect((await h.state.read(SENDER)).appointment === null).toBe(clears);
      },
    );

    it('ALREADY_RESOLVED closes the registry row as RESOLVED', async () => {
      const h = setup({
        cancel: [{ kind: 'ALREADY_RESOLVED', resolution: null }],
      });
      await h.handle('cancela mi cita');
      expect(h.closeRequest).toHaveBeenCalledWith('req-77', 'RESOLVED');
    });

    it('a throwing cancel keeps the appointment and says nothing', async () => {
      const h = setup({ cancel: [new Error('network')] });
      await expect(h.handle('cancela mi cita')).resolves.toEqual({
        kind: 'pass',
      });
      expect((await h.state.read(SENDER)).appointment).toEqual(APPOINTMENT);
    });

    it('a registry failure after the backend cancelled still answers and clears', async () => {
      const h = setup({ closeFails: true });
      await expect(h.handle('cancela mi cita')).resolves.toEqual({
        kind: 'reply',
        text: cancelledText(),
      });
      expect((await h.state.read(SENDER)).appointment).toBeNull();
    });

    it('a cancelled appointment never answers "¿a qué hora quedé?" again', async () => {
      const h = setup();
      await h.handle('cancela mi cita');
      await expect(h.handle('¿a qué hora quedé?')).resolves.toBeNull();
    });
  });
});
