import { Logger } from '@nestjs/common';
import type { HumanRequestCreateService } from '../../human-requests/application/human-request-create.service';
import {
  ASK_TEAM_OPEN_LIMIT_REPLY,
  ASK_TEAM_RATE_LIMITED_REPLY,
  TALK_TO_HUMAN_QUEUED_REPLY,
} from '../../human-requests/domain/human-request-create';
import {
  TALK_TO_HUMAN_IN_HOURS_REPLY,
  TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
  type OutOfHoursPolicy,
} from '../domain/out-of-hours-policy';
import { TalkToHumanService } from './talk-to-human.service';

const SENDER = '5215550001111';
const INPUT = {
  senderId: SENDER,
  text: 'quiero hablar con una persona',
  inboundAt: '2026-11-12T16:00:00.000Z',
  triggerWaMessageId: 'wamid.T1',
};

type Outcome = Awaited<
  ReturnType<HumanRequestCreateService['requestTalkToHuman']>
>;

const registered = (
  patch: Partial<Extract<Outcome, { kind: 'registered' }>> = {},
): Outcome => ({
  kind: 'registered',
  requestId: 'r-1',
  merged: false,
  businessHours: null,
  ...patch,
});

function setup(outcome: Outcome | Error, policy?: OutOfHoursPolicy) {
  const requestTalkToHuman = jest.fn(() =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome),
  );
  const service = new TalkToHumanService({
    team: { requestTalkToHuman },
    ...(policy === undefined ? {} : { policy }),
  });
  return { service, requestTalkToHuman };
}

describe('TalkToHumanService.handle', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates the request with the customer text and the trigger', async () => {
    const h = setup(registered());
    await h.service.handle(INPUT);
    expect(h.requestTalkToHuman).toHaveBeenCalledWith(INPUT);
  });

  it('in hours (businessHours.openNow true): the in-hours text', async () => {
    const h = setup(
      registered({ businessHours: { openNow: true, nextOpenAt: null } }),
    );
    await expect(h.service.handle(INPUT)).resolves.toBe(
      TALK_TO_HUMAN_IN_HOURS_REPLY,
    );
  });

  it('businessHours null is not "closed": the in-hours text', async () => {
    const h = setup(registered({ businessHours: null }));
    await expect(h.service.handle(INPUT)).resolves.toBe(
      TALK_TO_HUMAN_IN_HOURS_REPLY,
    );
  });

  it('out of hours (openNow false): the fixed out-of-hours text by default', async () => {
    const h = setup(
      registered({
        businessHours: {
          openNow: false,
          nextOpenAt: '2026-11-13T15:00:00.000Z',
        },
      }),
    );
    await expect(h.service.handle(INPUT)).resolves.toBe(
      TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
    );
  });

  it('out of hours goes through the OutOfHoursPolicy (unit 14 branch point)', async () => {
    const outOfHoursReply = jest.fn(() => Promise.resolve('texto de agenda'));
    const businessHours = {
      openNow: false,
      nextOpenAt: '2026-11-13T15:00:00.000Z',
    };
    const h = setup(
      registered({ requestId: 'r-9', merged: true, businessHours }),
      { outOfHoursReply },
    );
    await expect(h.service.handle(INPUT)).resolves.toBe('texto de agenda');
    expect(outOfHoursReply).toHaveBeenCalledWith({
      senderId: SENDER,
      requestId: 'r-9',
      merged: true,
      businessHours,
    });
  });

  it('the policy is not consulted in hours', async () => {
    const outOfHoursReply = jest.fn(() => Promise.resolve('x'));
    const h = setup(
      registered({ businessHours: { openNow: true, nextOpenAt: null } }),
      { outOfHoursReply },
    );
    await h.service.handle(INPUT);
    expect(outOfHoursReply).not.toHaveBeenCalled();
  });

  it('a failing policy falls back to the fixed out-of-hours text', async () => {
    const h = setup(
      registered({ businessHours: { openNow: false, nextOpenAt: null } }),
      { outOfHoursReply: () => Promise.reject(new Error('boom')) },
    );
    await expect(h.service.handle(INPUT)).resolves.toBe(
      TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
    );
  });

  it('a repeated ask (merged) gets the same copy', async () => {
    const h = setup(registered({ merged: true }));
    await expect(h.service.handle(INPUT)).resolves.toBe(
      TALK_TO_HUMAN_IN_HOURS_REPLY,
    );
  });

  it.each([
    [{ kind: 'queued' } as const, TALK_TO_HUMAN_QUEUED_REPLY],
    [{ kind: 'open_limit' } as const, ASK_TEAM_OPEN_LIMIT_REPLY],
    [{ kind: 'customer_rate_limited' } as const, ASK_TEAM_RATE_LIMITED_REPLY],
  ])('%j answers the matching fixed copy', async (outcome, copy) => {
    const h = setup(outcome);
    await expect(h.service.handle(INPUT)).resolves.toBe(copy);
  });

  it('a failed create promises nothing: null (the agent turn runs)', async () => {
    const h = setup({ kind: 'failed', reason: 'SUBTYPE_DISABLED' });
    await expect(h.service.handle(INPUT)).resolves.toBeNull();
  });

  it('a throwing team service also yields null and never the phone in logs', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const h = setup(new Error(`boom ${SENDER}`));
    await expect(h.service.handle(INPUT)).resolves.toBeNull();
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(SENDER);
  });
});
