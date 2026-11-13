import {
  FixedHoursOutOfHoursPolicy,
  TALK_TO_HUMAN_IN_HOURS_REPLY,
  TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
} from './out-of-hours-policy';

describe('talk-to-human copy (S5, owner-approved, usted)', () => {
  it('in hours', () => {
    expect(TALK_TO_HUMAN_IN_HOURS_REPLY).toBe(
      'Con gusto, ya le pedí a una persona del equipo que le atienda. En cuanto alguien esté disponible, le escribe por aquí.',
    );
  });

  it('out of hours', () => {
    expect(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY).toBe(
      'Nuestro equipo atiende de lunes a sábado de 9 a 19 h. Ya dejé su solicitud y le escriben en cuanto abramos.',
    );
  });
});

describe('FixedHoursOutOfHoursPolicy (default for unit 14)', () => {
  it('answers the fixed out-of-hours text whatever the context', async () => {
    const policy = new FixedHoursOutOfHoursPolicy();
    await expect(
      policy.outOfHoursReply({
        senderId: '5215550001111',
        requestId: 'r-1',
        merged: false,
        businessHours: { openNow: false, nextOpenAt: null },
      }),
    ).resolves.toBe(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY);
    await expect(
      policy.outOfHoursReply({
        senderId: '5215550001111',
        requestId: null,
        merged: true,
        businessHours: {
          openNow: false,
          nextOpenAt: '2026-11-13T15:00:00.000Z',
        },
      }),
    ).resolves.toBe(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY);
  });
});
