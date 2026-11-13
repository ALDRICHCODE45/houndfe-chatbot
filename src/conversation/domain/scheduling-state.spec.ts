import {
  EMPTY_SCHEDULING_STATE,
  OFFER_TTL_MS,
  isOfferExpired,
  normalizeSchedulingState,
  readSchedulingState,
  type SchedulingAppointment,
  type SchedulingOffer,
} from './scheduling-state';

const OFFER: SchedulingOffer = {
  slots: [
    { startsAt: '2026-11-13T15:00:00.000Z', withinWindow: true },
    { startsAt: '2026-11-13T15:30:00.000Z', withinWindow: false },
  ],
  timeZone: 'America/Mexico_City',
  offeredAt: '2026-11-12T20:00:00.000Z',
  subtype: 'TALK_TO_HUMAN',
  sourceRequestId: '0b0f7c58-6f55-4f4f-a1c4-9a2b7d6a4e11',
  openWhen: 'mañana a las 9:00 a. m.',
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

describe('readSchedulingState', () => {
  it('reads absent, null and non-object values as the empty state', () => {
    for (const raw of [undefined, null, 'x', 7, [], true]) {
      expect(readSchedulingState(raw)).toEqual(EMPTY_SCHEDULING_STATE);
    }
  });

  it('round-trips a full state', () => {
    const raw = { offer: OFFER, appointment: APPOINTMENT };
    expect(readSchedulingState(raw)).toEqual(raw);
  });

  it('keeps openWhen optional and unclearCount defaulting to 0', () => {
    const { openWhen: _openWhen, unclearCount: _unclear, ...bare } = OFFER;
    void _openWhen;
    void _unclear;
    const state = readSchedulingState({ offer: bare, appointment: null });
    expect(state.offer).toEqual({ ...bare, unclearCount: 0 });
    expect(state.offer).not.toHaveProperty('openWhen');
  });

  it('drops a malformed offer or appointment independently', () => {
    expect(
      readSchedulingState({
        offer: { ...OFFER, slots: [] },
        appointment: APPOINTMENT,
      }),
    ).toEqual({ offer: null, appointment: APPOINTMENT });
    expect(
      readSchedulingState({
        offer: OFFER,
        appointment: { ...APPOINTMENT, scheduleVersion: 'x' },
      }),
    ).toEqual({ offer: OFFER, appointment: null });
  });

  it('rejects more than 3 offered slots, unparsable instants and bad subtypes', () => {
    const slot = OFFER.slots[0];
    expect(
      readSchedulingState({
        offer: { ...OFFER, slots: [slot, slot, slot, slot] },
      }).offer,
    ).toBeNull();
    expect(
      readSchedulingState({
        offer: {
          ...OFFER,
          slots: [{ startsAt: 'mañana', withinWindow: true }],
        },
      }).offer,
    ).toBeNull();
    expect(
      readSchedulingState({ offer: { ...OFFER, subtype: 'RESTOCK' } }).offer,
    ).toBeNull();
  });

  it('allows an unknown appointment time zone (recovered from the state route)', () => {
    const recovered = { ...APPOINTMENT, timeZone: null };
    expect(
      readSchedulingState({ offer: null, appointment: recovered }).appointment,
    ).toEqual(recovered);
  });

  it('accepts scheduleVersion 0 (unknown: any newer version wins) but not negatives', () => {
    expect(
      readSchedulingState({
        appointment: { ...APPOINTMENT, scheduleVersion: 0 },
      }).appointment,
    ).not.toBeNull();
    expect(
      readSchedulingState({
        appointment: { ...APPOINTMENT, scheduleVersion: -1 },
      }).appointment,
    ).toBeNull();
  });

  it('returns detached copies', () => {
    const raw = { offer: OFFER, appointment: APPOINTMENT };
    const state = readSchedulingState(raw);
    state.offer!.slots[0].startsAt = 'changed';
    expect(raw.offer.slots[0].startsAt).toBe('2026-11-13T15:00:00.000Z');
  });

  it('drops unknown extra keys', () => {
    const state = readSchedulingState({
      offer: { ...OFFER, phone: '5215550001111' },
      appointment: { ...APPOINTMENT, phone: '5215550001111' },
      extra: 1,
    });
    expect(JSON.stringify(state)).not.toContain('5215550001111');
    expect(state).not.toHaveProperty('extra');
  });
});

describe('normalizeSchedulingState (write guard)', () => {
  it('returns the canonical document with both keys', () => {
    expect(
      normalizeSchedulingState({ offer: OFFER, appointment: null }),
    ).toEqual({ offer: OFFER, appointment: null });
    expect(
      normalizeSchedulingState({ offer: null, appointment: null }),
    ).toEqual(EMPTY_SCHEDULING_STATE);
  });

  it('refuses anything malformed (never silently dropping a half)', () => {
    expect(normalizeSchedulingState(null)).toBeNull();
    expect(normalizeSchedulingState({})).toBeNull();
    expect(
      normalizeSchedulingState({
        offer: { ...OFFER, slots: [] },
        appointment: null,
      }),
    ).toBeNull();
    expect(
      normalizeSchedulingState({
        offer: null,
        appointment: { ...APPOINTMENT, requestId: '' },
      }),
    ).toBeNull();
  });
});

describe('isOfferExpired', () => {
  const now = (ms: number) => new Date(Date.parse(OFFER.offeredAt) + ms);

  it('is active up to ~30 minutes and expired after', () => {
    expect(OFFER_TTL_MS).toBe(30 * 60_000);
    expect(isOfferExpired(OFFER, now(0))).toBe(false);
    expect(isOfferExpired(OFFER, now(OFFER_TTL_MS - 1))).toBe(false);
    expect(isOfferExpired(OFFER, now(OFFER_TTL_MS))).toBe(true);
    expect(isOfferExpired(OFFER, now(OFFER_TTL_MS + 1))).toBe(true);
  });

  it('an unparsable offeredAt is expired (fail closed)', () => {
    expect(isOfferExpired({ ...OFFER, offeredAt: 'x' }, now(0))).toBe(true);
  });
});
