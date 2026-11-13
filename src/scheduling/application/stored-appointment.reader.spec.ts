import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { SchedulingAppointment } from '../../conversation/domain/scheduling-state';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { HumanRequestRecord } from '../../human-requests/domain/human-request-feed';
import { SchedulingStateService } from './scheduling-state.service';
import { StoredAppointmentReader } from './stored-appointment.reader';

const SENDER = '5215550001111';
const APPOINTMENT: SchedulingAppointment = {
  requestId: 'req-1',
  subtype: 'TALK_TO_HUMAN',
  scheduledFor: '2026-11-13T15:00:00.000Z',
  scheduleVersion: 2,
  timeZone: 'America/Mexico_City',
  rescheduleCount: 1,
};

const record = (
  patch: Partial<HumanRequestRecord> = {},
): HumanRequestRecord => ({
  requestId: 'req-1',
  conversationRef: conversationRefFor(SENDER),
  subtype: 'TALK_TO_HUMAN',
  legacyId: null,
  status: 'OPEN',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...patch,
});

function setup(registryRow: HumanRequestRecord | null = record()) {
  const store = new InMemoryConversationStore();
  const getConversationState = jest.fn();
  const state = new SchedulingStateService(
    { store, live: { getConversationState } },
    { clock: () => new Date('2026-11-12T20:00:00.000Z') },
  );
  const getRequest = jest.fn(() => Promise.resolve(registryRow));
  const reader = new StoredAppointmentReader({
    state,
    registry: { getRequest },
  });
  return { store, state, reader, getRequest, getConversationState };
}

describe('StoredAppointmentReader (SCHEDULED_APPOINTMENT_READER backed by the scheduling state)', () => {
  it('answers the stored schedule of the request (found through the sender when given)', async () => {
    const h = setup();
    await h.state.bookAppointment(SENDER, APPOINTMENT);
    await expect(h.reader.knownSchedule('req-1', SENDER)).resolves.toEqual({
      scheduledFor: APPOINTMENT.scheduledFor,
      scheduleVersion: 2,
      timeZone: 'America/Mexico_City',
    });
    expect(h.getRequest).not.toHaveBeenCalled();
  });

  it('without a sender it finds the conversation through the request registry', async () => {
    const h = setup();
    await h.state.bookAppointment(SENDER, APPOINTMENT);
    await expect(h.reader.knownSchedule('req-1')).resolves.toMatchObject({
      scheduleVersion: 2,
    });
    expect(h.getRequest).toHaveBeenCalledWith('req-1');
  });

  it('never reads the backend (local only) and an unknown version is 0', async () => {
    const h = setup();
    await h.state.bookAppointment(SENDER, {
      ...APPOINTMENT,
      scheduleVersion: 0,
      timeZone: null,
    });
    await expect(h.reader.knownSchedule('req-1', SENDER)).resolves.toEqual({
      scheduledFor: APPOINTMENT.scheduledFor,
      scheduleVersion: 0,
      timeZone: null,
    });
    expect(h.getConversationState).not.toHaveBeenCalled();
  });

  it.each([
    ['another request is stored', { ...APPOINTMENT, requestId: 'req-2' }],
    ['no appointment is stored', null],
  ])('null when %s', async (_name, appointment) => {
    const h = setup();
    if (appointment !== null)
      await h.state.bookAppointment(SENDER, appointment);
    await expect(h.reader.knownSchedule('req-1', SENDER)).resolves.toBeNull();
  });

  it('null when the registry does not know the request and no sender is given', async () => {
    const h = setup(null);
    await expect(h.reader.knownSchedule('req-1')).resolves.toBeNull();
  });

  it('null when the registry row has an unusable conversation ref', async () => {
    const h = setup(record({ conversationRef: 'not-a-ref' }));
    await expect(h.reader.knownSchedule('req-1')).resolves.toBeNull();
  });

  it('rejects when the local read fails (the feed retries the item)', async () => {
    const h = setup();
    jest.spyOn(h.store, 'getScheduling').mockRejectedValue(new Error('db'));
    await expect(h.reader.knownSchedule('req-1', SENDER)).rejects.toThrow('db');
  });

  it('rejects when the registry read fails', async () => {
    const h = setup();
    h.getRequest.mockRejectedValue(new Error('registry'));
    await expect(h.reader.knownSchedule('req-1')).rejects.toThrow('registry');
  });
});
