import { Logger } from '@nestjs/common';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { SchedulingClient } from '../../chatbot-api/domain/scheduling.port';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type {
  CancelHumanRequestResult,
  CreateHumanRequestResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  ListSlotsResult,
  RescheduleRequestResult,
} from '../../chatbot-api/domain/dtos/scheduling.dto';
import type { GetConversationStateResult } from '../../chatbot-api/domain/dtos/live-conversation.dto';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  OFFER_TTL_MS,
  type SchedulingOffer,
} from '../../conversation/domain/scheduling-state';
import {
  ASK_TEAM_OPEN_LIMIT_REPLY,
  ASK_TEAM_RATE_LIMITED_REPLY,
  TALK_TO_HUMAN_QUEUED_REPLY,
} from '../../human-requests/domain/human-request-create';
import { TALK_TO_HUMAN_OUT_OF_HOURS_REPLY } from '../../whatsapp/domain/out-of-hours-policy';
import {
  alreadyBookedText,
  bookedOutOfWindowText,
  bookedText,
  noSlotsText,
  notUnderstoodText,
  offerText,
  rescheduledText,
  slotTakenText,
  whatTimeText,
} from '../domain/scheduling-copy';
import { formatWhen, slotLabel } from '../domain/slot-time';
import { AppointmentIntentService } from './appointment-intent.service';
import { SchedulingOutOfHoursPolicy } from './scheduling-out-of-hours.policy';
import {
  SchedulingStateConflictError,
  SchedulingStateService,
} from './scheduling-state.service';

const SENDER = '5215550001111';
const REF = conversationRefFor(SENDER);
const ZONE = 'America/Mexico_City';
const NOW = new Date('2026-11-12T20:00:00.000Z'); // Thu 14:00 in Mexico City
const INBOUND = '2026-11-12T19:59:30.000Z';
const NEXT_OPEN = '2026-11-13T15:00:00.000Z'; // Fri 09:00
const SLOT_1 = '2026-11-13T15:00:00.000Z';
const SLOT_2 = '2026-11-13T15:30:00.000Z';
const SLOT_3 = '2026-11-13T16:00:00.000Z';
const WINDOW_CLOSES = '2026-11-13T19:59:30.000Z';

const hours = (openNow: boolean, nextOpenAt: string | null = NEXT_OPEN) => ({
  openNow,
  nextOpenAt,
  timeZone: ZONE,
  weeklyRanges: [],
  closedDates: [],
});

const slotsOk = (
  slots: { startsAt: string; withinWindow: boolean }[],
  businessHours = hours(false),
): ListSlotsResult => ({
  kind: 'ok',
  timeZone: ZONE,
  whatsappWindowClosesAt: WINDOW_CLOSES,
  businessHours,
  slots,
});

const THREE = [
  { startsAt: SLOT_1, withinWindow: true },
  { startsAt: SLOT_2, withinWindow: true },
  { startsAt: SLOT_3, withinWindow: false },
];

const booked = (
  patch: Record<string, unknown> = {},
  at = SLOT_1,
): CreateHumanRequestResult => ({
  kind: 'ok',
  status: 201,
  response: {
    id: 'req-77',
    folio: 'S-000077',
    status: 'NEW',
    outcome: 'CREATED',
    mergedIntoId: null,
    businessHours: { openNow: false, nextOpenAt: NEXT_OPEN, timeZone: ZONE },
    scheduledFor: at,
    scheduleVersion: 1,
    requiresTemplateAtStart: false,
    whatsappWindowClosesAt: WINDOW_CLOSES,
    ...patch,
  },
});

const label = (iso: string) => slotLabel(iso, ZONE, NOW);
const OPEN_WHEN = formatWhen(NEXT_OPEN, ZONE, NOW);

const stateOk = (
  scheduledRequest: {
    requestId: string;
    subtype: string;
    scheduledFor: string;
    needsReschedule: boolean;
    scheduleVersion: number;
  } | null = null,
): GetConversationStateResult => ({
  kind: 'ok',
  mode: 'BOT',
  handoffEpoch: 0,
  sessionState: null,
  requestId: null,
  assigneeFirstName: null,
  scheduledRequest,
});

function setup(
  options: {
    slots?: ListSlotsResult | Error;
    create?: (CreateHumanRequestResult | Error)[];
    team?: Awaited<
      ReturnType<
        import('../../human-requests/application/human-request-create.service').HumanRequestCreateService['requestTalkToHuman']
      >
    >;
    state?: GetConversationStateResult;
    now?: Date;
    /** Wall-clock cost of every create call (ms), to bound the retry. */
    createLatencyMs?: number;
    reschedule?: RescheduleRequestResult;
    cancel?: CancelHumanRequestResult;
  } = {},
) {
  const store = new InMemoryConversationStore();
  let nowMs = (options.now ?? NOW).getTime();
  const clock = () => new Date(nowMs);
  const getConversationState = jest.fn(() =>
    Promise.resolve(options.state ?? stateOk()),
  );
  const state = new SchedulingStateService(
    { store, live: { getConversationState } },
    { clock },
  );
  const listSlots = jest.fn(() =>
    options.slots instanceof Error
      ? Promise.reject(options.slots)
      : Promise.resolve(options.slots ?? slotsOk(THREE)),
  );
  const queue = [...(options.create ?? [booked()])];
  const createHumanRequest = jest.fn(() => {
    nowMs += options.createLatencyMs ?? 0;
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const requestTalkToHuman = jest.fn(() =>
    Promise.resolve(
      options.team ?? {
        kind: 'registered' as const,
        requestId: 'req-unscheduled',
        merged: false,
        businessHours: null,
      },
    ),
  );
  const recordOpenRequest = jest.fn(() => Promise.resolve());
  const sleep = jest.fn((ms: number) => {
    nowMs += ms;
    return Promise.resolve();
  });
  const rescheduleRequest = jest.fn<
    ReturnType<SchedulingClient['rescheduleRequest']>,
    Parameters<SchedulingClient['rescheduleRequest']>
  >(() =>
    Promise.resolve<RescheduleRequestResult>(
      options.reschedule ?? {
        kind: 'ok',
        status: 'RESCHEDULED',
        requestId: 'req-77',
        scheduledFor: SLOT_2,
        previousScheduledFor: SLOT_1,
        scheduleVersion: 2,
        requiresTemplateAtStart: false,
        whatsappWindowClosesAt: null,
      },
    ),
  );
  const cancelHumanRequest = jest.fn<
    ReturnType<HumanRequestsClient['cancelHumanRequest']>,
    Parameters<HumanRequestsClient['cancelHumanRequest']>
  >(() =>
    Promise.resolve<CancelHumanRequestResult>(
      options.cancel ?? {
        kind: 'ok',
        response: {
          id: 'req-77',
          status: 'CANCELLED',
          reason: 'CUSTOMER_WITHDREW',
          cancelledAt: NOW.toISOString(),
        },
      },
    ),
  );
  const closeRequest = jest.fn(() => Promise.resolve(true));
  let seq = 0;
  const appointments = new AppointmentIntentService(
    {
      scheduling: { listSlots, rescheduleRequest },
      requests: { cancelHumanRequest },
      state,
      registry: { closeRequest },
    },
    {
      clock,
      newKey: () =>
        `99999999-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    },
  );
  const policy = new SchedulingOutOfHoursPolicy(
    {
      scheduling: { listSlots },
      requests: { createHumanRequest },
      state,
      team: { requestTalkToHuman },
      registry: { recordOpenRequest },
      appointments,
    },
    {
      clock,
      newSourceRequestId: () =>
        `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sleep,
    },
  );
  return {
    policy,
    store,
    state,
    listSlots,
    createHumanRequest,
    requestTalkToHuman,
    recordOpenRequest,
    sleep,
    getConversationState,
    rescheduleRequest,
    cancelHumanRequest,
    elapsedMs: () => nowMs - (options.now ?? NOW).getTime(),
  };
}

const ASK = {
  senderId: SENDER,
  inboundAt: INBOUND,
  triggerWaMessageId: 'wamid.ASK',
};
const reply = (text: string, messageId = 'wamid.R1') => ({
  senderId: SENDER,
  text,
  inboundAt: INBOUND,
  messageId,
});

async function withOffer(h: ReturnType<typeof setup>) {
  const plan = await h.policy.planAsk(ASK);
  expect(plan.kind).toBe('reply');
  return (await h.state.read(SENDER)).offer!;
}

describe('SchedulingOutOfHoursPolicy.planAsk (T3: out-of-hours branch)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks the slots first, with the conversation ref and the inbound time', async () => {
    const h = setup();
    await h.policy.planAsk(ASK);
    expect(h.listSlots).toHaveBeenCalledWith({
      conversationRef: REF,
      lastCustomerMessageAt: INBOUND,
    });
    expect(h.createHumanRequest).not.toHaveBeenCalled();
    expect(h.requestTalkToHuman).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', null],
    ['unparsable', 'ayer'],
    ['more than 5 min in the future', '2026-11-12T20:30:00.000Z'],
    ['older than 30 days', '2026-09-01T00:00:00.000Z'],
  ])(
    'lastCustomerMessageAt falls back to now when the inbound is %s',
    async (_c, inboundAt) => {
      const h = setup();
      await h.policy.planAsk({ ...ASK, inboundAt });
      expect(h.listSlots).toHaveBeenCalledWith({
        conversationRef: REF,
        lastCustomerMessageAt: NOW.toISOString(),
      });
    },
  );

  it("SCHEDULING_DISABLED: today's behavior (default plan), nothing stored", async () => {
    const h = setup({ slots: { kind: 'SCHEDULING_DISABLED' } });
    await expect(h.policy.planAsk(ASK)).resolves.toEqual({ kind: 'default' });
    expect(await h.store.get(SENDER)).toBeNull();
  });

  it.each([
    [
      'a typed failure',
      { kind: 'RATE_LIMITED', retryAfterSeconds: 1 } as never,
    ],
    ['a throwing client', new Error(`boom ${SENDER}`)],
  ])(
    '%s: default plan (the unit 11 create decides), never throws',
    async (_c, slots) => {
      const h = setup({ slots });
      await expect(h.policy.planAsk(ASK)).resolves.toEqual({ kind: 'default' });
      expect(await h.store.get(SENDER)).toBeNull();
    },
  );

  it('the branch is open: default plan (in-hours path unchanged), no offer', async () => {
    const h = setup({ slots: slotsOk(THREE, hours(true)) });
    await expect(h.policy.planAsk(ASK)).resolves.toEqual({ kind: 'default' });
    expect(await h.store.get(SENDER)).toBeNull();
  });

  it('closed with no free slots: create the unscheduled request and tell {cuándo}', async () => {
    const h = setup({ slots: slotsOk([]) });
    await expect(h.policy.planAsk(ASK)).resolves.toEqual({
      kind: 'create_then_reply',
      closedReply: noSlotsText(OPEN_WHEN),
    });
    expect(OPEN_WHEN).toBe('mañana a las 9:00 a. m.');
    expect(h.createHumanRequest).not.toHaveBeenCalled();
    expect(await h.store.get(SENDER)).toBeNull();
  });

  it('closed but nextOpenAt unknown: default plan (no {cuándo} to promise)', async () => {
    const h = setup({ slots: slotsOk(THREE, hours(false, null)) });
    await expect(h.policy.planAsk(ASK)).resolves.toEqual({ kind: 'default' });
    expect(await h.store.get(SENDER)).toBeNull();
  });

  it('closed with slots: stores the offer and answers the approved numbered text, WITHOUT creating the request', async () => {
    const h = setup();
    const plan = await h.policy.planAsk(ASK);
    expect(plan).toEqual({
      kind: 'reply',
      text: offerText(
        OPEN_WHEN,
        THREE.map((s) => label(s.startsAt)),
      ),
    });
    expect(plan.kind === 'reply' && plan.text).toBe(
      'Ahorita nuestro equipo no está disponible (abrimos mañana a las 9:00 a. m.). ' +
        '¿Quiere que una persona le atienda en alguno de estos horarios?\n' +
        '1. mañana a las 9:00 a. m.\n2. mañana a las 9:30 a. m.\n3. mañana a las 10:00 a. m.\n' +
        'Responda con el número.',
    );
    const offer = (await h.state.read(SENDER)).offer!;
    expect(offer).toEqual({
      slots: THREE,
      timeZone: ZONE,
      offeredAt: NOW.toISOString(),
      subtype: 'TALK_TO_HUMAN',
      sourceRequestId: '00000000-0000-4000-8000-000000000001',
      openWhen: OPEN_WHEN,
      unclearCount: 0,
    });
    expect(h.createHumanRequest).not.toHaveBeenCalled();
    expect(h.requestTalkToHuman).not.toHaveBeenCalled();
  });

  it('a new ask replaces a previous offer with fresh slots and a fresh key', async () => {
    const h = setup();
    await h.policy.planAsk(ASK);
    await h.policy.planAsk(ASK);
    expect((await h.state.read(SENDER)).offer!.sourceRequestId).toBe(
      '00000000-0000-4000-8000-000000000002',
    );
  });

  it('keeps an existing appointment while offering', async () => {
    const h = setup();
    await h.state.bookAppointment(SENDER, {
      requestId: 'req-1',
      subtype: 'TALK_TO_HUMAN',
      scheduledFor: SLOT_1,
      scheduleVersion: 1,
      timeZone: ZONE,
      rescheduleCount: 0,
    });
    await h.policy.planAsk(ASK);
    const read = await h.state.read(SENDER);
    expect(read.offer).not.toBeNull();
    expect(read.appointment?.requestId).toBe('req-1');
  });

  it('an unusable sender id is the default plan without any call', async () => {
    const h = setup();
    await expect(
      h.policy.planAsk({ ...ASK, senderId: 'not-a-phone' }),
    ).resolves.toEqual({ kind: 'default' });
    expect(h.listSlots).not.toHaveBeenCalled();
  });

  it('a failing offer write falls back to the default plan (never an unrecorded offer)', async () => {
    const h = setup();
    jest.spyOn(h.store, 'commitScheduling').mockResolvedValue(false);
    await expect(h.policy.planAsk(ASK)).resolves.toEqual({ kind: 'default' });
  });

  it('outOfHoursReply (after an unscheduled create) is the fixed text', async () => {
    const h = setup();
    await expect(
      h.policy.outOfHoursReply({
        senderId: SENDER,
        requestId: 'r',
        merged: false,
        businessHours: { openNow: false, nextOpenAt: NEXT_OPEN },
      }),
    ).resolves.toBe(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY);
  });
});

describe('SchedulingOutOfHoursPolicy.handleReply (T3: the customer answers the offer)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('without an active offer it passes after ONE local read (no backend call)', async () => {
    const h = setup();
    const getScheduling = jest.spyOn(h.store, 'getScheduling');
    await expect(h.policy.handleReply(reply('hola'))).resolves.toEqual({
      kind: 'pass',
    });
    expect(getScheduling).toHaveBeenCalledTimes(1);
    expect(h.listSlots).not.toHaveBeenCalled();
    expect(h.createHumanRequest).not.toHaveBeenCalled();
    expect(h.getConversationState).not.toHaveBeenCalled();
  });

  it('a chosen slot books INLINE with the offer key, the slot and the inbound time', async () => {
    const h = setup({ create: [booked({}, SLOT_2)] });
    const offer = await withOffer(h);
    const result = await h.policy.handleReply(reply('2', 'wamid.CHOICE'));
    expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
    expect(h.createHumanRequest).toHaveBeenCalledWith({
      sourceRequestId: offer.sourceRequestId,
      subtype: 'TALK_TO_HUMAN',
      customer: { phoneCountryCode: '52', phone: expect.any(String) as string },
      conversationRef: REF,
      lastCustomerMessageAt: INBOUND,
      summary: expect.any(String) as string,
      scheduledFor: SLOT_2,
      triggerWaMessageId: 'wamid.CHOICE',
    });
    const body = (
      h.createHumanRequest.mock.calls as unknown as [Record<string, unknown>][]
    )[0][0];
    // A scheduled create never merges: no dedupKey; "2" is not the customer's need.
    expect(body).not.toHaveProperty('dedupKey');
    expect(body).not.toHaveProperty('needs');
    expect(result).toEqual({ kind: 'reply', text: bookedText(label(SLOT_2)) });
  });

  it('never goes through the outbox or the unscheduled create path', async () => {
    const h = setup();
    await withOffer(h);
    await h.policy.handleReply(reply('1'));
    expect(h.requestTalkToHuman).not.toHaveBeenCalled();
  });

  it('booked: stores the appointment, clears the offer, registers the open request', async () => {
    const h = setup({ create: [booked({ scheduleVersion: 4 })] });
    await withOffer(h);
    await h.policy.handleReply(reply('1'));
    const read = await h.state.read(SENDER);
    expect(read.offer).toBeNull();
    expect(read.appointment).toEqual({
      requestId: 'req-77',
      subtype: 'TALK_TO_HUMAN',
      scheduledFor: SLOT_1,
      scheduleVersion: 4,
      timeZone: ZONE,
      rescheduleCount: 0,
    });
    expect(h.recordOpenRequest).toHaveBeenCalledWith({
      requestId: 'req-77',
      conversationRef: REF,
      subtype: 'TALK_TO_HUMAN',
      legacyId: null,
    });
  });

  it('a registry failure does not undo the booking', async () => {
    const h = setup();
    h.recordOpenRequest.mockRejectedValueOnce(new Error('db'));
    await withOffer(h);
    const result = await h.policy.handleReply(reply('1'));
    expect(result.kind).toBe('reply');
    expect((await h.state.read(SENDER)).appointment).not.toBeNull();
  });

  it('a slot outside the free window gets the "out of window" text', async () => {
    const h = setup({ create: [booked({}, SLOT_3)] });
    await withOffer(h);
    await expect(h.policy.handleReply(reply('3'))).resolves.toEqual({
      kind: 'reply',
      text: bookedOutOfWindowText(label(SLOT_3)),
    });
  });

  it('requiresTemplateAtStart from the booking answer wins over withinWindow', async () => {
    const h = setup({ create: [booked({ requiresTemplateAtStart: true })] });
    await withOffer(h);
    await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
      kind: 'reply',
      text: bookedOutOfWindowText(label(SLOT_1)),
    });
  });

  it('SLOT_UNAVAILABLE: the offer is replaced with the returned slots (new key) and the slot-taken text answers; no retry of the same slot', async () => {
    const fresh = [
      { startsAt: SLOT_2, withinWindow: true },
      { startsAt: SLOT_3, withinWindow: true },
    ];
    const h = setup({
      create: [
        {
          kind: 'SLOT_UNAVAILABLE',
          slots: fresh,
          timeZone: ZONE,
          whatsappWindowClosesAt: WINDOW_CLOSES,
        },
      ],
    });
    const before = await withOffer(h);
    const result = await h.policy.handleReply(reply('1'));
    expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'reply',
      text: slotTakenText(fresh.map((s) => label(s.startsAt))),
    });
    const after = (await h.state.read(SENDER)).offer!;
    expect(after.slots).toEqual(fresh);
    expect(after.sourceRequestId).not.toBe(before.sourceRequestId);
    expect(after.unclearCount).toBe(0);
    expect(after.openWhen).toBe(OPEN_WHEN);
    expect(after.offeredAt).toBe(NOW.toISOString());
    // The customer can then choose from the new list.
    const next = await h.policy.handleReply(reply('1'));
    expect(h.createHumanRequest).toHaveBeenCalledTimes(2);
    expect(next.kind).toBe('reply');
  });

  it('SLOT_UNAVAILABLE with nothing free: unscheduled request + the no-slots text, offer dropped', async () => {
    const h = setup({
      create: [
        {
          kind: 'SLOT_UNAVAILABLE',
          slots: [],
          timeZone: ZONE,
          whatsappWindowClosesAt: WINDOW_CLOSES,
        },
      ],
    });
    await withOffer(h);
    await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
      kind: 'reply',
      text: noSlotsText(OPEN_WHEN),
    });
    expect(h.requestTalkToHuman).toHaveBeenCalledTimes(1);
    expect((await h.state.read(SENDER)).offer).toBeNull();
  });

  it.each([
    [{ kind: 'queued' } as const, TALK_TO_HUMAN_QUEUED_REPLY],
    [{ kind: 'open_limit' } as const, ASK_TEAM_OPEN_LIMIT_REPLY],
  ])(
    'SLOT_UNAVAILABLE with nothing free and the unscheduled create %j',
    async (team, copy) => {
      const h = setup({
        team,
        create: [
          {
            kind: 'SLOT_UNAVAILABLE',
            slots: [],
            timeZone: ZONE,
            whatsappWindowClosesAt: WINDOW_CLOSES,
          },
        ],
      });
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: copy,
      });
    },
  );

  it('SLOT_UNAVAILABLE with nothing free and a failed unscheduled create passes to the agent', async () => {
    const h = setup({
      team: { kind: 'failed', reason: 'x' },
      create: [
        {
          kind: 'SLOT_UNAVAILABLE',
          slots: [],
          timeZone: ZONE,
          whatsappWindowClosesAt: WINDOW_CLOSES,
        },
      ],
    });
    await withOffer(h);
    await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
      kind: 'pass',
    });
  });

  it('ALREADY_SCHEDULED: stores the appointment from the answer (version from the state route), clears the offer, answers "ya tiene una cita"', async () => {
    const h = setup({
      create: [
        {
          kind: 'ALREADY_SCHEDULED',
          requestId: 'req-old',
          scheduledFor: SLOT_3,
        },
      ],
      state: stateOk({
        requestId: 'req-old',
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: SLOT_3,
        needsReschedule: false,
        scheduleVersion: 5,
      }),
    });
    await withOffer(h);
    await expect(h.policy.handleReply(reply('2'))).resolves.toEqual({
      kind: 'reply',
      text: alreadyBookedText(label(SLOT_3)),
    });
    const read = await h.state.read(SENDER);
    expect(read.offer).toBeNull();
    expect(read.appointment).toEqual({
      requestId: 'req-old',
      subtype: 'TALK_TO_HUMAN',
      scheduledFor: SLOT_3,
      scheduleVersion: 5,
      timeZone: ZONE,
      rescheduleCount: 0,
      // T4: «¿Quiere cambiarla?» is armed for the next "sí".
      changeAskedAt: NOW.toISOString(),
    });
  });

  it('ALREADY_SCHEDULED with an unreadable state route: version 0 (unknown), still answered', async () => {
    const h = setup({
      create: [
        {
          kind: 'ALREADY_SCHEDULED',
          requestId: 'req-old',
          scheduledFor: SLOT_3,
        },
      ],
      state: { kind: 'RATE_LIMITED' } as never,
    });
    await withOffer(h);
    const result = await h.policy.handleReply(reply('2'));
    expect(result).toEqual({
      kind: 'reply',
      text: alreadyBookedText(label(SLOT_3)),
    });
    expect((await h.state.read(SENDER)).appointment).toMatchObject({
      requestId: 'req-old',
      scheduleVersion: 0,
      timeZone: ZONE,
    });
  });

  describe('transient booking failures', () => {
    it('retries the SAME key and books on a later attempt', async () => {
      const h = setup({
        create: [
          new Error('ECONNRESET'),
          { kind: 'RATE_LIMITED', retryAfterSeconds: null },
          booked(),
        ],
      });
      const offer = await withOffer(h);
      const result = await h.policy.handleReply(reply('1'));
      expect(result.kind).toBe('reply');
      expect(h.createHumanRequest).toHaveBeenCalledTimes(3);
      const keys = (
        h.createHumanRequest.mock.calls as unknown as [
          { sourceRequestId: string },
        ][]
      ).map((call) => call[0].sourceRequestId);
      expect(new Set(keys)).toEqual(new Set([offer.sourceRequestId]));
      expect(h.sleep).toHaveBeenCalledTimes(2);
    });

    it('honors a Retry-After inside the budget', async () => {
      const h = setup({
        create: [{ kind: 'RATE_LIMITED', retryAfterSeconds: 7 }, booked()],
      });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      expect(h.sleep).toHaveBeenCalledWith(7000);
    });

    it('a Retry-After beyond the ~30 s budget stops at once: offer kept, pass', async () => {
      const h = setup({
        create: [{ kind: 'RATE_LIMITED', retryAfterSeconds: 120 }],
      });
      const offer = await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
      expect((await h.state.read(SENDER)).offer).toEqual(offer);
    });

    it('gives up after three attempts: the offer is kept untouched and the message goes to the agent', async () => {
      const h = setup({ create: [new Error('timeout')] });
      const offer = await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
      expect(h.createHumanRequest).toHaveBeenCalledTimes(3);
      const read = await h.state.read(SENDER);
      expect(read.offer).toEqual(offer);
      expect(read.appointment).toBeNull();
    });

    it('VERSION_CONFLICT is transient too', async () => {
      const h = setup({ create: [{ kind: 'VERSION_CONFLICT' }, booked()] });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      expect(h.createHumanRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('permanent booking refusals', () => {
    it.each([[{ kind: 'CUSTOMER_OPEN_LIMIT', limit: 3, open: 3 } as const]])(
      '%j: the approved "open limit" copy, offer dropped',
      async (result) => {
        const h = setup({ create: [result] });
        await withOffer(h);
        await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
          kind: 'reply',
          text: ASK_TEAM_OPEN_LIMIT_REPLY,
        });
        expect((await h.state.read(SENDER)).offer).toBeNull();
      },
    );

    it.each([
      ['SCHEDULING_DISABLED'],
      ['SUBTYPE_DISABLED'],
      ['IDEMPOTENCY_CONFLICT'],
      ['NOT_FOUND'],
    ])(
      '%s: nothing is promised, offer dropped, the agent turn runs',
      async (kind) => {
        const h = setup({ create: [{ kind } as never] });
        await withOffer(h);
        await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
          kind: 'pass',
        });
        expect((await h.state.read(SENDER)).offer).toBeNull();
        expect(h.sleep).not.toHaveBeenCalled();
      },
    );

    it('a booking answer without scheduledFor (a backend that ignored it) is never "agendado": the fixed out-of-hours text', async () => {
      const h = setup({
        create: [
          {
            kind: 'ok',
            status: 201,
            response: {
              id: 'req-77',
              folio: null,
              status: 'NEW',
              outcome: 'CREATED',
              mergedIntoId: null,
              businessHours: null,
            },
          },
        ],
      });
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
      });
      const read = await h.state.read(SENDER);
      expect(read.offer).toBeNull();
      expect(read.appointment).toBeNull();
    });
  });

  describe('unclear answers', () => {
    it('the first one answers "no entendí" once and keeps the offer', async () => {
      const h = setup();
      await withOffer(h);
      await expect(h.policy.handleReply(reply('mmm no sé'))).resolves.toEqual({
        kind: 'reply',
        text: notUnderstoodText(),
      });
      expect((await h.state.read(SENDER)).offer?.unclearCount).toBe(1);
      expect(h.createHumanRequest).not.toHaveBeenCalled();
    });

    it('the second one drops the offer and the message goes to the agent', async () => {
      const h = setup();
      await withOffer(h);
      await h.policy.handleReply(reply('mmm'));
      await expect(h.policy.handleReply(reply('quién sabe'))).resolves.toEqual({
        kind: 'pass',
      });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      expect(h.createHumanRequest).not.toHaveBeenCalled();
    });

    it('a valid choice after one unclear answer still books', async () => {
      const h = setup({ create: [booked({}, SLOT_2)] });
      await withOffer(h);
      await h.policy.handleReply(reply('mmm'));
      const result = await h.policy.handleReply(reply('el segundo'));
      expect(result).toEqual({
        kind: 'reply',
        text: bookedText(label(SLOT_2)),
      });
    });

    it('an unoffered number is unclear, not a booking', async () => {
      const h = setup({ slots: slotsOk(THREE.slice(0, 2)) });
      await withOffer(h);
      const result = await h.policy.handleReply(reply('3'));
      expect(result).toEqual({ kind: 'reply', text: notUnderstoodText() });
      expect(h.createHumanRequest).not.toHaveBeenCalled();
    });
  });

  describe('offer expiry', () => {
    it('after ~30 minutes the offer is dropped and the message goes to the agent (no booking, no text)', async () => {
      const h = setup();
      await withOffer(h);
      const later = new Date(NOW.getTime() + OFFER_TTL_MS + 1000);
      const expired = setup({ now: later });
      // Same durable state, later clock.
      await expired.store.create(SENDER, {
        lastMessageAt: NOW.toISOString(),
        data: { scheduling: (await h.store.getScheduling(SENDER)).raw },
      });
      await expect(expired.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
      expect(expired.createHumanRequest).not.toHaveBeenCalled();
      expect((await expired.state.read(SENDER)).offer).toBeNull();
    });

    it('right before expiry the offer still books', async () => {
      const h = setup();
      await withOffer(h);
      const almost = new Date(NOW.getTime() + OFFER_TTL_MS - 1000);
      const near = setup({ now: almost });
      await near.store.create(SENDER, {
        lastMessageAt: NOW.toISOString(),
        data: { scheduling: (await h.store.getScheduling(SENDER)).raw },
      });
      const result = await near.policy.handleReply(reply('1'));
      expect(result.kind).toBe('reply');
      expect(near.createHumanRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('safety', () => {
    it('never throws: a state failure passes the message to the agent', async () => {
      const h = setup();
      jest
        .spyOn(h.store, 'getScheduling')
        .mockRejectedValue(new Error(`db ${SENDER}`));
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
    });

    it('never puts the phone in a log line', async () => {
      const logs: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((message: unknown) => {
            logs.push(String(message));
          });
      }
      const h = setup({
        create: [new Error(`ECONNRESET ${SENDER}`)],
        slots: slotsOk(THREE),
      });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      const bad = setup({ slots: new Error(`down ${SENDER}`) });
      await bad.policy.planAsk(ASK);
      expect(logs.join('\n')).not.toContain(SENDER);
    });

    it('the offered copy carries no raw ISO instant or offset', async () => {
      const h = setup();
      const plan = await h.policy.planAsk(ASK);
      const text = plan.kind === 'reply' ? plan.text : '';
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(text).not.toMatch(/UTC|GMT|[+-]\d{2}:\d{2}/);
    });
  });
});

describe('SchedulingOutOfHoursPolicy review advisories (T4 fold-in)', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logs.push(String(message));
        });
  });
  afterEach(() => {
    expect(logs.join('\n')).not.toContain(SENDER);
    jest.restoreAllMocks();
  });

  describe('(1) a confirmed booking is never "pass"', () => {
    it('a failing local appointment write still sends the booked text and drops the offer best-effort', async () => {
      const h = setup();
      await withOffer(h);
      jest
        .spyOn(h.state, 'bookAppointment')
        .mockRejectedValue(new Error(`db ${SENDER}`));
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: bookedText(label(SLOT_1)),
      });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      expect(h.recordOpenRequest).toHaveBeenCalledTimes(1);
    });

    it('a CAS loss on the appointment write is the same: the out-of-window text when it applies', async () => {
      const h = setup({ create: [booked({}, SLOT_3)] });
      await withOffer(h);
      jest
        .spyOn(h.state, 'bookAppointment')
        .mockRejectedValue(new SchedulingStateConflictError());
      await expect(h.policy.handleReply(reply('3'))).resolves.toEqual({
        kind: 'reply',
        text: bookedOutOfWindowText(label(SLOT_3)),
      });
    });

    it('even when dropping the offer fails too', async () => {
      const h = setup();
      await withOffer(h);
      jest.spyOn(h.state, 'bookAppointment').mockRejectedValue(new Error('x'));
      jest.spyOn(h.state, 'clearOffer').mockRejectedValue(new Error('y'));
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: bookedText(label(SLOT_1)),
      });
    });

    it('a booking answer with no schedule still answers the fixed copy when the offer cannot be dropped', async () => {
      const h = setup({
        create: [
          {
            kind: 'ok',
            status: 201,
            response: {
              id: 'req-77',
              folio: null,
              status: 'NEW',
              outcome: 'CREATED',
              mergedIntoId: null,
              businessHours: null,
            },
          },
        ],
      });
      await withOffer(h);
      jest.spyOn(h.state, 'clearOffer').mockRejectedValue(new Error('y'));
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
      });
    });
  });

  describe('(2) never more than 3 slots in an offer', () => {
    const FOUR = [
      ...THREE,
      { startsAt: '2026-11-13T16:30:00.000Z', withinWindow: false },
    ];

    it('planAsk truncates to 3 before storing and offering', async () => {
      const h = setup({ slots: slotsOk(FOUR) });
      const plan = await h.policy.planAsk(ASK);
      expect(plan).toEqual({
        kind: 'reply',
        text: offerText(
          OPEN_WHEN,
          THREE.map((slot) => label(slot.startsAt)),
        ),
      });
      expect((await h.state.read(SENDER)).offer?.slots).toEqual(THREE);
    });

    it('the SLOT_UNAVAILABLE re-offer truncates to 3', async () => {
      const h = setup({
        create: [
          {
            kind: 'SLOT_UNAVAILABLE',
            slots: FOUR,
            timeZone: ZONE,
            whatsappWindowClosesAt: WINDOW_CLOSES,
          },
        ],
      });
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: slotTakenText(THREE.map((slot) => label(slot.startsAt))),
      });
      expect((await h.state.read(SENDER)).offer?.slots).toEqual(THREE);
    });
  });

  describe('(3) the key of a booking that gave up', () => {
    const giveUp = async (h: ReturnType<typeof setup>) => {
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
    };
    const committedRoute = (at = SLOT_2, requestId = 'req-77') =>
      stateOk({
        requestId,
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: at,
        needsReschedule: false,
        scheduleVersion: 3,
      });

    it('IDEMPOTENCY_CONFLICT + the backend holds the chosen slot: stored, registered, booked text', async () => {
      const h = setup({
        create: [
          new Error('timeout'),
          new Error('timeout'),
          new Error('timeout'),
          { kind: 'IDEMPOTENCY_CONFLICT' },
        ],
        state: committedRoute(SLOT_2),
      });
      await giveUp(h);
      const result = await h.policy.handleReply(reply('2', 'wamid.NEXT'));
      expect(result).toEqual({
        kind: 'reply',
        text: bookedText(label(SLOT_2)),
      });
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
      const read = await h.state.read(SENDER);
      expect(read.offer).toBeNull();
      expect(read.appointment).toMatchObject({
        requestId: 'req-77',
        scheduledFor: SLOT_2,
        scheduleVersion: 3,
      });
      expect(h.recordOpenRequest).toHaveBeenCalledWith({
        requestId: 'req-77',
        conversationRef: REF,
        subtype: 'TALK_TO_HUMAN',
        legacyId: null,
      });
    });

    it('the recovered appointment is at another time: "ya tiene una cita" and the change question is armed', async () => {
      const h = setup({
        create: [
          new Error('timeout'),
          new Error('timeout'),
          new Error('timeout'),
          { kind: 'IDEMPOTENCY_CONFLICT' },
        ],
        state: committedRoute(SLOT_1),
      });
      await giveUp(h);
      await expect(h.policy.handleReply(reply('3'))).resolves.toEqual({
        kind: 'reply',
        text: alreadyBookedText(label(SLOT_1)),
      });
      const read = await h.state.read(SENDER);
      expect(read.offer).toBeNull();
      // (The clock moved by the retry pauses before the conflict.)
      expect(
        Date.parse(read.appointment?.changeAskedAt ?? ''),
      ).toBeGreaterThanOrEqual(NOW.getTime());
    });

    it('nothing committed on the backend: a fresh key is stored and used for the chosen slot', async () => {
      const h = setup({
        create: [
          new Error('timeout'),
          new Error('timeout'),
          new Error('timeout'),
          { kind: 'IDEMPOTENCY_CONFLICT' },
          booked({}, SLOT_2),
        ],
        state: stateOk(null),
      });
      const before = await withOffer(h);
      await h.policy.handleReply(reply('1'));
      const result = await h.policy.handleReply(reply('2'));
      expect(result).toEqual({
        kind: 'reply',
        text: bookedText(label(SLOT_2)),
      });
      const keys = (
        h.createHumanRequest.mock.calls as unknown as [
          { sourceRequestId: string },
        ][]
      ).map((call) => call[0].sourceRequestId);
      expect(keys).toHaveLength(5);
      expect(new Set(keys.slice(0, 4))).toEqual(
        new Set([before.sourceRequestId]),
      );
      expect(keys[4]).not.toBe(before.sourceRequestId);
      expect((await h.state.read(SENDER)).appointment).toMatchObject({
        scheduledFor: SLOT_2,
      });
    });

    it('a second conflict on the fresh key drops the offer and the agent answers', async () => {
      const h = setup({
        create: [
          new Error('timeout'),
          new Error('timeout'),
          new Error('timeout'),
          { kind: 'IDEMPOTENCY_CONFLICT' },
        ],
        state: stateOk(null),
      });
      await giveUp(h);
      await expect(h.policy.handleReply(reply('2'))).resolves.toEqual({
        kind: 'pass',
      });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      // 3 attempts + the conflict + one fresh-key attempt that conflicts again.
      expect(h.createHumanRequest).toHaveBeenCalledTimes(5);
    });
  });

  describe('(4) the inline retry is bounded by elapsed wall-clock (≤ 10 s)', () => {
    it('slow calls count: two 6 s failures stop the loop before a third attempt', async () => {
      const h = setup({
        create: [new Error('timeout')],
        createLatencyMs: 6_000,
      });
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
      expect(h.createHumanRequest).toHaveBeenCalledTimes(2);
      expect(h.elapsedMs()).toBeLessThanOrEqual(10_000 + 6_000);
    });

    it('a call that already used the budget gets no pause and no retry', async () => {
      const h = setup({
        create: [new Error('timeout')],
        createLatencyMs: 10_000,
      });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
      expect(h.sleep).not.toHaveBeenCalled();
    });

    it('fast failures still get the 3 attempts (1 s + 3 s pauses)', async () => {
      const h = setup({ create: [new Error('timeout')] });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      expect(h.createHumanRequest).toHaveBeenCalledTimes(3);
      expect(h.sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 3_000]);
    });

    it('a Retry-After above the 10 s budget stops at once', async () => {
      const h = setup({
        create: [{ kind: 'RATE_LIMITED', retryAfterSeconds: 11 }],
      });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
      expect(h.sleep).not.toHaveBeenCalled();
    });
  });

  describe('(5) other booking outcomes', () => {
    it('CUSTOMER_RATE_LIMITED: the approved rate-limit copy, offer dropped, no retry', async () => {
      const h = setup({
        create: [
          { kind: 'CUSTOMER_RATE_LIMITED', limit: null, retryAfterSeconds: 30 },
        ],
      });
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'reply',
        text: ASK_TEAM_RATE_LIMITED_REPLY,
      });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
      expect(h.sleep).not.toHaveBeenCalled();
    });

    it('VALIDATION_ERROR: nothing is promised, offer dropped, error logged without the phone', async () => {
      const h = setup({
        create: [{ kind: 'VALIDATION_ERROR', message: `bad ${SENDER}` }],
      });
      await withOffer(h);
      await expect(h.policy.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
      expect((await h.state.read(SENDER)).offer).toBeNull();
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
      expect(logs.some((line) => line.includes('VALIDATION_ERROR'))).toBe(true);
    });
  });

  describe('T4 delegation to the appointment intents', () => {
    it('"¿a qué hora quedé?" answers from the stored appointment', async () => {
      const h = setup();
      await h.state.bookAppointment(SENDER, {
        requestId: 'req-77',
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: SLOT_3,
        scheduleVersion: 1,
        timeZone: ZONE,
        rescheduleCount: 0,
      });
      await expect(
        h.policy.handleReply(reply('¿a qué hora quedé?')),
      ).resolves.toEqual({
        kind: 'reply',
        text: whatTimeText(label(SLOT_3)),
      });
    });

    it('ALREADY_SCHEDULED arms the question: "sí" then starts the change and the choice reschedules (never a second booking)', async () => {
      const h = setup({
        create: [
          {
            kind: 'ALREADY_SCHEDULED',
            requestId: 'req-77',
            scheduledFor: SLOT_3,
          },
        ],
        state: stateOk({
          requestId: 'req-77',
          subtype: 'TALK_TO_HUMAN',
          scheduledFor: SLOT_3,
          needsReschedule: false,
          scheduleVersion: 2,
        }),
      });
      await withOffer(h);
      await h.policy.handleReply(reply('1'));
      expect((await h.state.read(SENDER)).appointment?.changeAskedAt).toBe(
        NOW.toISOString(),
      );
      const offered = await h.policy.handleReply(reply('sí'));
      expect(offered.kind).toBe('reply');
      expect((await h.state.read(SENDER)).offer?.rescheduleRequestId).toBe(
        'req-77',
      );
      const done = await h.policy.handleReply(reply('2'));
      expect(done).toEqual({
        kind: 'reply',
        text: rescheduledText(label(SLOT_2)),
      });
      expect(h.rescheduleRequest).toHaveBeenCalledTimes(1);
      // Only the first (ALREADY_SCHEDULED) create ever happened.
      expect(h.createHumanRequest).toHaveBeenCalledTimes(1);
    });

    it('a reschedule offer is never mistaken for a booking offer when the intents are not wired', async () => {
      const h = setup();
      await h.state.bookAppointment(SENDER, {
        requestId: 'req-77',
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: SLOT_3,
        scheduleVersion: 1,
        timeZone: ZONE,
        rescheduleCount: 0,
      });
      await h.state.storeOffer(SENDER, {
        slots: THREE,
        timeZone: ZONE,
        offeredAt: NOW.toISOString(),
        subtype: 'TALK_TO_HUMAN',
        sourceRequestId: '11111111-1111-4111-8111-111111111111',
        unclearCount: 0,
        rescheduleRequestId: 'req-77',
      });
      const bare = new SchedulingOutOfHoursPolicy({
        scheduling: { listSlots: h.listSlots },
        requests: { createHumanRequest: h.createHumanRequest },
        state: h.state,
        team: { requestTalkToHuman: h.requestTalkToHuman },
        registry: { recordOpenRequest: h.recordOpenRequest },
      });
      await expect(bare.handleReply(reply('1'))).resolves.toEqual({
        kind: 'pass',
      });
      expect(h.createHumanRequest).not.toHaveBeenCalled();
    });

    it('a cancel while a booking offer is open and no appointment exists falls to the booking offer logic', async () => {
      const h = setup();
      await withOffer(h);
      const result = await h.policy.handleReply(reply('cancela mi cita'));
      // No appointment anywhere: the offer logic ("cancel" is not a slot).
      expect(h.cancelHumanRequest).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'reply', text: notUnderstoodText() });
    });
  });
});

describe('offer shape (documented state)', () => {
  it('matches the spec: slots, timeZone, offeredAt, subtype, sourceRequestId, openWhen', async () => {
    const h = setup();
    await h.policy.planAsk(ASK);
    const offer = (await h.state.read(SENDER)).offer as SchedulingOffer;
    expect(Object.keys(offer).sort()).toEqual(
      [
        'offeredAt',
        'openWhen',
        'slots',
        'sourceRequestId',
        'subtype',
        'timeZone',
        'unclearCount',
      ].sort(),
    );
  });
});
