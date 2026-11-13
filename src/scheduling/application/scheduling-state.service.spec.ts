import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type {
  SchedulingAppointment,
  SchedulingOffer,
} from '../../conversation/domain/scheduling-state';
import { SchedulingStateService } from './scheduling-state.service';

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
