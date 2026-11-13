import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type {
  SchedulingAppointment,
  SchedulingOffer,
} from '../../conversation/domain/scheduling-state';
import {
  SchedulingStateConflictError,
  SchedulingStateInvalidError,
  SchedulingStateService,
} from './scheduling-state.service';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-12T20:00:00.000Z');

const OFFER: SchedulingOffer = {
  slots: [{ startsAt: '2026-11-13T15:00:00.000Z', withinWindow: true }],
  timeZone: 'America/Mexico_City',
  offeredAt: NOW.toISOString(),
  subtype: 'TALK_TO_HUMAN',
  sourceRequestId: '0b0f7c58-6f55-4f4f-a1c4-9a2b7d6a4e11',
  unclearCount: 0,
};

const APPOINTMENT: SchedulingAppointment = {
  requestId: 'req-1',
  subtype: 'TALK_TO_HUMAN',
  scheduledFor: '2026-11-13T15:00:00.000Z',
  scheduleVersion: 1,
  timeZone: 'America/Mexico_City',
  rescheduleCount: 0,
};

type StateResult = Awaited<
  ReturnType<
    import('../../chatbot-api/domain/live-conversation.port').LiveConversationClient['getConversationState']
  >
>;

const summary = {
  requestId: 'req-9',
  subtype: 'TALK_TO_HUMAN',
  scheduledFor: '2026-11-14T16:00:00.000Z',
  needsReschedule: false,
  scheduleVersion: 3,
};

function setup(state?: StateResult | Error) {
  const store = new InMemoryConversationStore();
  const getConversationState = jest.fn(() =>
    state instanceof Error
      ? Promise.reject(state)
      : Promise.resolve<StateResult>(state ?? emptyState),
  );
  const service = new SchedulingStateService(
    { store, live: { getConversationState } },
    { clock: () => NOW },
  );
  return { store, service, getConversationState };
}

const emptyState: StateResult = {
  kind: 'ok',
  mode: 'BOT',
  handoffEpoch: 0,
  sessionState: null,
  requestId: null,
  assigneeFirstName: null,
  scheduledRequest: null,
};

const okState = (scheduledRequest: typeof summary | null): StateResult => ({
  kind: 'ok',
  mode: 'BOT',
  handoffEpoch: 0,
  sessionState: null,
  requestId: null,
  assigneeFirstName: null,
  scheduledRequest,
});

describe('SchedulingStateService (offer / appointment state)', () => {
  it('starts empty', async () => {
    const h = setup();
    await expect(h.service.read(SENDER)).resolves.toEqual({
      offer: null,
      appointment: null,
    });
  });

  it('a store without scheduling support does not break construction: operations reject', async () => {
    const service = new SchedulingStateService({
      store: {},
      live: { getConversationState: jest.fn() },
    });
    await expect(service.read(SENDER)).rejects.toThrow(/scheduling support/i);
    await expect(service.clearOffer(SENDER)).rejects.toThrow(
      /scheduling support/i,
    );
    // getAppointment never throws.
    await expect(service.getAppointment(SENDER)).resolves.toBeNull();
  });

  it('storeOffer replaces the offer and keeps the appointment', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await h.service.storeOffer(SENDER, OFFER);
    const next = { ...OFFER, sourceRequestId: 'other', unclearCount: 0 };
    await h.service.storeOffer(SENDER, next);
    await expect(h.service.read(SENDER)).resolves.toEqual({
      offer: next,
      appointment: APPOINTMENT,
    });
  });

  it('bookAppointment stores the appointment and clears the offer in one write', async () => {
    const h = setup();
    await h.service.storeOffer(SENDER, OFFER);
    const commit = jest.spyOn(h.store, 'commitScheduling');
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    expect(commit).toHaveBeenCalledTimes(1);
    await expect(h.service.read(SENDER)).resolves.toEqual({
      offer: null,
      appointment: APPOINTMENT,
    });
  });

  it('bumpUnclear counts the misses and returns the new offer', async () => {
    const h = setup();
    await h.service.storeOffer(SENDER, OFFER);
    const once = await h.service.bumpUnclear(SENDER);
    expect(once?.unclearCount).toBe(1);
    const twice = await h.service.bumpUnclear(SENDER);
    expect(twice?.unclearCount).toBe(2);
  });

  it('bumpUnclear without an offer is a no-op returning null', async () => {
    const h = setup();
    await expect(h.service.bumpUnclear(SENDER)).resolves.toBeNull();
  });

  it('clearOffer drops only the offer', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await h.service.storeOffer(SENDER, OFFER);
    await h.service.clearOffer(SENDER);
    await expect(h.service.read(SENDER)).resolves.toEqual({
      offer: null,
      appointment: APPOINTMENT,
    });
  });

  it('clearOffer with nothing stored writes nothing (no row is created)', async () => {
    const h = setup();
    const commit = jest.spyOn(h.store, 'commitScheduling');
    await h.service.clearOffer(SENDER);
    expect(commit).not.toHaveBeenCalled();
    expect(await h.store.get(SENDER)).toBeNull();
  });

  it('clearAppointment drops the appointment only for the same request', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await h.service.clearAppointment(SENDER, 'another-request');
    expect((await h.service.read(SENDER)).appointment).toEqual(APPOINTMENT);
    await h.service.clearAppointment(SENDER, APPOINTMENT.requestId);
    expect((await h.service.read(SENDER)).appointment).toBeNull();
  });

  it('retries a lost CAS against the fresh state (a concurrent writer)', async () => {
    const h = setup();
    await h.service.storeOffer(SENDER, OFFER);
    const real = h.store.commitScheduling.bind(h.store);
    let calls = 0;
    jest
      .spyOn(h.store, 'commitScheduling')
      .mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) {
          // A concurrent writer slips in between the read and the write.
          await real(
            SENDER,
            (await h.store.getScheduling(SENDER)).raw,
            { offer: OFFER, appointment: APPOINTMENT },
            NOW.toISOString(),
          );
        }
        return real(...args);
      });
    const result = await h.service.bumpUnclear(SENDER);
    // The lost attempt, then the retry against the fresh state.
    expect(calls).toBe(2);
    expect(result?.unclearCount).toBe(1);
    expect((await h.service.read(SENDER)).appointment).toEqual(APPOINTMENT);
  });

  it('gives up with an error after repeated CAS losses', async () => {
    const h = setup();
    await h.service.storeOffer(SENDER, OFFER);
    jest.spyOn(h.store, 'commitScheduling').mockResolvedValue(false);
    await expect(h.service.clearOffer(SENDER)).rejects.toThrow(/conflict/i);
  });

  it('an invalid state is rejected at once as a validation error, never spun through the CAS rounds', async () => {
    const h = setup();
    const commit = jest.spyOn(h.store, 'commitScheduling');
    const tooMany = {
      ...OFFER,
      slots: Array.from({ length: 4 }, () => OFFER.slots[0]),
    };
    await expect(h.service.storeOffer(SENDER, tooMany)).rejects.toBeInstanceOf(
      SchedulingStateInvalidError,
    );
    expect(commit).not.toHaveBeenCalled();
    // A CAS loss stays a different error.
    commit.mockResolvedValue(false);
    await expect(h.service.storeOffer(SENDER, OFFER)).rejects.toBeInstanceOf(
      SchedulingStateConflictError,
    );
    expect(commit).toHaveBeenCalledTimes(3);
  });

  describe('T4: customer intents', () => {
    it('markChangeAsked / clearChangeAsked set and drop the question flag of the appointment', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, APPOINTMENT);
      await h.service.markChangeAsked(
        SENDER,
        APPOINTMENT.requestId,
        NOW.toISOString(),
      );
      expect((await h.service.read(SENDER)).appointment).toEqual({
        ...APPOINTMENT,
        changeAskedAt: NOW.toISOString(),
      });
      await h.service.clearChangeAsked(SENDER);
      expect((await h.service.read(SENDER)).appointment).not.toHaveProperty(
        'changeAskedAt',
      );
    });

    it('markChangeAsked ignores another request; clearChangeAsked without the flag writes nothing', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, APPOINTMENT);
      const commit = jest.spyOn(h.store, 'commitScheduling');
      await h.service.markChangeAsked(SENDER, 'other', NOW.toISOString());
      await h.service.clearChangeAsked(SENDER);
      expect(commit).not.toHaveBeenCalled();
    });

    it('startReschedule stores the offer and drops the question flag in one write', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        changeAskedAt: NOW.toISOString(),
      });
      const commit = jest.spyOn(h.store, 'commitScheduling');
      const offer = { ...OFFER, rescheduleRequestId: APPOINTMENT.requestId };
      await h.service.startReschedule(SENDER, offer);
      expect(commit).toHaveBeenCalledTimes(1);
      await expect(h.service.read(SENDER)).resolves.toEqual({
        offer,
        appointment: APPOINTMENT,
      });
    });

    it('recordCustomerReschedule updates time, version and zone, counts the change, drops the offer and the flag', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        timeZone: null,
        changeAskedAt: NOW.toISOString(),
      });
      await h.service.storeOffer(SENDER, {
        ...OFFER,
        rescheduleRequestId: APPOINTMENT.requestId,
      });
      await h.service.recordCustomerReschedule(SENDER, {
        requestId: APPOINTMENT.requestId,
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: '2026-11-14T16:00:00.000Z',
        scheduleVersion: 2,
        timeZone: 'America/Mexico_City',
        counted: true,
      });
      await expect(h.service.read(SENDER)).resolves.toEqual({
        offer: null,
        appointment: {
          ...APPOINTMENT,
          scheduledFor: '2026-11-14T16:00:00.000Z',
          scheduleVersion: 2,
          timeZone: 'America/Mexico_City',
          rescheduleCount: 1,
        },
        rescheduleCount: 1,
      });
    });

    it('recordCustomerReschedule with counted:false (UNCHANGED) does not count', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, APPOINTMENT);
      await h.service.recordCustomerReschedule(SENDER, {
        requestId: APPOINTMENT.requestId,
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: APPOINTMENT.scheduledFor,
        scheduleVersion: 1,
        timeZone: 'America/Mexico_City',
        counted: false,
      });
      expect((await h.service.read(SENDER)).appointment?.rescheduleCount).toBe(
        0,
      );
    });

    it('recordCustomerReschedule never moves the version backwards (a staff change landed first)', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        scheduleVersion: 5,
        scheduledFor: '2026-11-20T15:00:00.000Z',
      });
      await h.service.recordCustomerReschedule(SENDER, {
        requestId: APPOINTMENT.requestId,
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: '2026-11-14T16:00:00.000Z',
        scheduleVersion: 2,
        timeZone: 'America/Mexico_City',
        counted: true,
      });
      const { appointment } = await h.service.read(SENDER);
      expect(appointment).toMatchObject({
        scheduledFor: '2026-11-20T15:00:00.000Z',
        scheduleVersion: 5,
        rescheduleCount: 1,
      });
    });

    it('recordCustomerReschedule without a local appointment of that request builds it from the answer', async () => {
      const h = setup();
      await h.service.recordCustomerReschedule(SENDER, {
        requestId: 'req-1',
        subtype: 'COMPLAINT',
        scheduledFor: '2026-11-14T16:00:00.000Z',
        scheduleVersion: 2,
        timeZone: 'America/Mexico_City',
        counted: true,
      });
      expect((await h.service.read(SENDER)).appointment).toEqual({
        requestId: 'req-1',
        subtype: 'COMPLAINT',
        scheduledFor: '2026-11-14T16:00:00.000Z',
        scheduleVersion: 2,
        timeZone: 'America/Mexico_City',
        rescheduleCount: 1,
      });
    });

    it('learnTimeZone fills only a missing zone of that request', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        timeZone: null,
      });
      await h.service.learnTimeZone(SENDER, 'other', 'America/Tijuana');
      expect((await h.service.read(SENDER)).appointment?.timeZone).toBeNull();
      await h.service.learnTimeZone(
        SENDER,
        APPOINTMENT.requestId,
        'America/Mexico_City',
      );
      expect((await h.service.read(SENDER)).appointment?.timeZone).toBe(
        'America/Mexico_City',
      );
      const commit = jest.spyOn(h.store, 'commitScheduling');
      await h.service.learnTimeZone(
        SENDER,
        APPOINTMENT.requestId,
        'America/Tijuana',
      );
      expect(commit).not.toHaveBeenCalled();
    });

    it('clearAppointment also drops a reschedule offer of that request (never an unrelated booking offer)', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, APPOINTMENT);
      await h.service.storeOffer(SENDER, {
        ...OFFER,
        rescheduleRequestId: APPOINTMENT.requestId,
      });
      await h.service.clearAppointment(SENDER, APPOINTMENT.requestId);
      await expect(h.service.read(SENDER)).resolves.toEqual({
        offer: null,
        appointment: null,
      });

      await h.service.bookAppointment(SENDER, APPOINTMENT);
      await h.service.storeOffer(SENDER, OFFER);
      await h.service.clearAppointment(SENDER, APPOINTMENT.requestId);
      expect((await h.service.read(SENDER)).offer).toEqual(OFFER);
    });
  });

  describe('T5 writer: recordStaffReschedule', () => {
    const update = (patch: Record<string, unknown> = {}) => ({
      requestId: APPOINTMENT.requestId,
      scheduledFor: '2026-11-14T16:30:00.000Z',
      scheduleVersion: 2,
      timeZone: 'America/Mexico_City' as string | null,
      ...patch,
    });

    it('a newer version replaces the time and the version (the count and the offer are untouched)', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        rescheduleCount: 2,
      });
      await h.service.recordStaffReschedule(SENDER, update());
      expect((await h.service.read(SENDER)).appointment).toEqual({
        ...APPOINTMENT,
        scheduledFor: '2026-11-14T16:30:00.000Z',
        scheduleVersion: 2,
        rescheduleCount: 2,
      });
    });

    it('an unknown local version (0) is replaced by any item', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        scheduleVersion: 0,
        timeZone: null,
      });
      await h.service.recordStaffReschedule(SENDER, update());
      expect((await h.service.read(SENDER)).appointment).toMatchObject({
        scheduleVersion: 2,
        scheduledFor: '2026-11-14T16:30:00.000Z',
        timeZone: 'America/Mexico_City',
      });
    });

    it('an older or equal version, another request or no appointment writes nothing', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, {
        ...APPOINTMENT,
        scheduleVersion: 3,
      });
      const commit = jest.spyOn(h.store, 'commitScheduling');
      await h.service.recordStaffReschedule(SENDER, update());
      await h.service.recordStaffReschedule(
        SENDER,
        update({ scheduleVersion: 3 }),
      );
      await h.service.recordStaffReschedule(
        SENDER,
        update({ requestId: 'other', scheduleVersion: 9 }),
      );
      expect(commit).not.toHaveBeenCalled();
      const empty = setup();
      const none = jest.spyOn(empty.store, 'commitScheduling');
      await empty.service.recordStaffReschedule(SENDER, update());
      expect(none).not.toHaveBeenCalled();
    });

    it('rejects when the store fails (the feed retries the item)', async () => {
      const h = setup();
      await h.service.bookAppointment(SENDER, APPOINTMENT);
      jest
        .spyOn(h.store, 'getScheduling')
        .mockRejectedValue(new Error('db down'));
      await expect(
        h.service.recordStaffReschedule(SENDER, update()),
      ).rejects.toThrow('db down');
    });
  });

  it('findAppointment reads the local appointment only (never the backend) and rejects on a store failure', async () => {
    const h = setup(okState(summary));
    await expect(h.service.findAppointment(SENDER)).resolves.toBeNull();
    expect(h.getConversationState).not.toHaveBeenCalled();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await expect(h.service.findAppointment(SENDER)).resolves.toEqual(
      APPOINTMENT,
    );
    jest.spyOn(h.store, 'getScheduling').mockRejectedValue(new Error('db'));
    await expect(h.service.findAppointment(SENDER)).rejects.toThrow('db');
  });

  describe('getAppointment (recovery from the state route)', () => {
    it('answers the local appointment WITHOUT reading the backend', async () => {
      const h = setup(okState(summary));
      await h.service.bookAppointment(SENDER, APPOINTMENT);
      await expect(h.service.getAppointment(SENDER)).resolves.toEqual(
        APPOINTMENT,
      );
      expect(h.getConversationState).not.toHaveBeenCalled();
    });

    it('with none locally reads scheduledRequest once, stores it and answers it', async () => {
      const h = setup(okState(summary));
      const recovered = await h.service.getAppointment(SENDER);
      expect(recovered).toEqual({
        requestId: 'req-9',
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: '2026-11-14T16:00:00.000Z',
        scheduleVersion: 3,
        timeZone: null,
        rescheduleCount: 0,
      });
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
      expect(h.getConversationState).toHaveBeenCalledWith(
        expect.stringMatching(/^wa:/),
      );
      // Stored: the next ask is local.
      await h.service.getAppointment(SENDER);
      expect(h.getConversationState).toHaveBeenCalledTimes(1);
    });

    it('no scheduledRequest on the backend → null, nothing stored', async () => {
      const h = setup(okState(null));
      await expect(h.service.getAppointment(SENDER)).resolves.toBeNull();
      expect(await h.store.get(SENDER)).toBeNull();
    });

    it('a pre-unit-14 answer (no scheduledRequest key) is null', async () => {
      const h = setup({
        kind: 'ok',
        mode: 'BOT',
        handoffEpoch: 0,
        sessionState: null,
        requestId: null,
        assigneeFirstName: null,
      });
      await expect(h.service.getAppointment(SENDER)).resolves.toBeNull();
    });

    it('a failed or throwing read is null (never throws, never invents one)', async () => {
      const failed = setup({ kind: 'RATE_LIMITED' } as unknown as StateResult);
      await expect(failed.service.getAppointment(SENDER)).resolves.toBeNull();
      const thrown = setup(new Error('boom'));
      await expect(thrown.service.getAppointment(SENDER)).resolves.toBeNull();
    });

    it('does not overwrite an appointment a concurrent booking stored meanwhile', async () => {
      const h = setup(okState(summary));
      h.getConversationState.mockImplementationOnce(async () => {
        await h.service.bookAppointment(SENDER, APPOINTMENT);
        return okState(summary);
      });
      await expect(h.service.getAppointment(SENDER)).resolves.toEqual(
        APPOINTMENT,
      );
    });

    it('never puts the phone in an error path', async () => {
      const h = setup(new Error(`failed for ${SENDER}`));
      const log = jest.spyOn(
        (await import('@nestjs/common')).Logger.prototype,
        'warn',
      );
      await h.service.getAppointment(SENDER);
      const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain(SENDER);
      log.mockRestore();
    });
  });
});

describe('scheduling writes never touch lastMessageAt (F3)', () => {
  const OLD = '2026-11-01T00:00:00.000Z';
  const seeded = async () => {
    const h = setup();
    await h.store.create(SENDER, {
      lastMessageAt: OLD,
      data: { messages: [{ role: 'user', content: 'hola' }] },
    });
    return h;
  };
  const lastMessageAt = async (h: Awaited<ReturnType<typeof seeded>>) =>
    (await h.store.get(SENDER))!.lastMessageAt;

  it('offer, booking, staff reschedule and clear leave the stored time alone', async () => {
    const h = await seeded();
    await h.service.storeOffer(SENDER, OFFER);
    expect(await lastMessageAt(h)).toBe(OLD);
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    expect(await lastMessageAt(h)).toBe(OLD);
    await h.service.recordStaffReschedule(SENDER, {
      requestId: APPOINTMENT.requestId,
      scheduledFor: '2026-11-14T15:00:00.000Z',
      scheduleVersion: 2,
      timeZone: null,
    });
    expect(await lastMessageAt(h)).toBe(OLD);
    await h.service.clearAppointment(SENDER, APPOINTMENT.requestId);
    expect(await lastMessageAt(h)).toBe(OLD);
  });

  it('a first-contact write still creates the row with the clock time', async () => {
    const h = setup();
    await h.service.storeOffer(SENDER, OFFER);
    expect(await lastMessageAt(h as never)).toBe(NOW.toISOString());
  });
});

describe('the reschedule count is per conversation (F5)', () => {
  const rescheduleOnce = (
    h: ReturnType<typeof setup>,
    patch: Record<string, unknown> = {},
  ) =>
    h.service.recordCustomerReschedule(SENDER, {
      requestId: APPOINTMENT.requestId,
      subtype: 'TALK_TO_HUMAN',
      scheduledFor: '2026-11-14T16:00:00.000Z',
      scheduleVersion: 2,
      timeZone: 'America/Mexico_City',
      counted: true,
      ...patch,
    });

  it('a customer reschedule counts at the conversation level', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await rescheduleOnce(h);
    expect((await h.service.read(SENDER)).rescheduleCount).toBe(1);
  });

  it('survives clearing the appointment and booking a new one (cancel and rebook)', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await rescheduleOnce(h);
    await rescheduleOnce(h, { scheduleVersion: 3 });
    await h.service.clearAppointment(SENDER, APPOINTMENT.requestId);
    expect((await h.service.read(SENDER)).rescheduleCount).toBe(2);
    await h.service.bookAppointment(SENDER, {
      ...APPOINTMENT,
      requestId: 'req-2',
      rescheduleCount: 0,
    });
    const state = await h.service.read(SENDER);
    expect(state.rescheduleCount).toBe(2);
    // The next counted change continues from 2, not from the new request's 0.
    await rescheduleOnce(h, { requestId: 'req-2', scheduleVersion: 2 });
    expect((await h.service.read(SENDER)).rescheduleCount).toBe(3);
  });

  it('survives the offer writes and a recovered appointment', async () => {
    const h = setup({ ...emptyState, kind: 'ok', scheduledRequest: summary });
    await h.store.commitScheduling(
      SENDER,
      undefined,
      { offer: null, appointment: null, rescheduleCount: 3 },
      NOW.toISOString(),
    );
    await h.service.storeOffer(SENDER, OFFER);
    await h.service.clearOffer(SENDER);
    const recovered = await h.service.getAppointment(SENDER);
    expect(recovered?.requestId).toBe(summary.requestId);
    expect(recovered?.rescheduleCount).toBe(0);
    const state = await h.service.read(SENDER);
    expect(state.rescheduleCount).toBe(3);
    await h.service.startReschedule(SENDER, {
      ...OFFER,
      rescheduleRequestId: summary.requestId,
    });
    await h.service.clearAppointment(SENDER, summary.requestId);
    expect((await h.service.read(SENDER)).rescheduleCount).toBe(3);
  });

  it('keeps reading the legacy per-appointment field', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, {
      ...APPOINTMENT,
      rescheduleCount: 2,
    });
    await rescheduleOnce(h);
    const state = await h.service.read(SENDER);
    expect(state.rescheduleCount).toBe(3);
    expect(state.appointment?.rescheduleCount).toBe(3);
  });

  it('UNCHANGED (not counted) leaves the conversation count alone', async () => {
    const h = setup();
    await h.service.bookAppointment(SENDER, APPOINTMENT);
    await rescheduleOnce(h, { counted: false });
    expect((await h.service.read(SENDER)).rescheduleCount ?? 0).toBe(0);
  });
});
