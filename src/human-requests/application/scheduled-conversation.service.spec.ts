import { Logger } from '@nestjs/common';
import type {
  DeliveryOutcomeInput,
  FeedItem,
  RecordDeliveryOutcomeResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { WhatsappSendError } from '../../whatsapp/infrastructure/meta-whatsapp.sender';
import {
  REF,
  SCHEDULE_DECISIONS,
  reminderItem,
  rescheduledItem,
} from '../infrastructure/human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestDeliveryService } from './human-request-delivery.service';
import {
  ScheduledConversationService,
  type KnownSchedule,
} from './scheduled-conversation.service';

const SENDER = '5215550001111';
// 08:50 in Mexico City (UTC-6 in November, no DST).
const NOW = new Date('2026-11-10T14:50:00.000Z');
const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'casual' };

const REMINDER_USTED =
  'Le recuerdo que a las 9:00 a. m. una persona del equipo le atiende por aquí.';
const CHANGED_USTED = 'El equipo cambió su cita para mañana a las 9:30 a. m.';

const harness = (
  options: { withHandler?: boolean; withReader?: boolean } = {},
) => {
  const withHandler = options.withHandler ?? true;
  const withReader = options.withReader ?? true;
  const store = new InMemoryHumanRequestFeedStore();
  const acks: DeliveryOutcomeInput[] = [];
  const sent: Array<{ to: string; text: string; staffReplyId?: string }> = [];
  const state = {
    human: false,
    humanUnreadable: false,
    // One entry per isWindowOpen call; the last one repeats.
    windowScript: [true] as boolean[],
    known: null as KnownSchedule | null,
    // One entry per read of the known schedule; the last one repeats.
    knownScript: null as Array<KnownSchedule | null> | null,
    style: null as CustomerStyle | null,
    sendScript: [] as Array<Error | string>,
    clock: NOW,
  };
  const calls = { window: 0, known: 0 };
  let attempt = 0;
  let wamid = 0;
  const handler = new ScheduledConversationService({
    store,
    isWindowOpen: () => {
      const i = Math.min(calls.window, state.windowScript.length - 1);
      calls.window += 1;
      return Promise.resolve(state.windowScript[i]);
    },
    customerStyle: () => Promise.resolve(state.style),
    ...(withReader
      ? {
          appointments: {
            knownSchedule: () => {
              const script = state.knownScript;
              const value =
                script === null
                  ? state.known
                  : script[Math.min(calls.known, script.length - 1)];
              calls.known += 1;
              return Promise.resolve(value);
            },
          },
        }
      : {}),
    clock: () => state.clock,
  });
  const service = new HumanRequestDeliveryService(
    {
      store,
      client: {
        recordDeliveryOutcome: (deliveryId, body) => {
          acks.push(body);
          return Promise.resolve<RecordDeliveryOutcomeResult>({
            kind: 'ok',
            response: {
              deliveryId,
              outcome: body.outcome,
              attemptId: body.attemptId,
              ackReceivedAt: null,
            },
          });
        },
        listPendingDeliveries: () => Promise.resolve({ kind: 'ok', items: [] }),
      },
      sender: {
        sendText: (message) => {
          sent.push(message);
          const next = state.sendScript.shift();
          if (next instanceof Error) return Promise.reject(next);
          wamid += 1;
          return Promise.resolve({
            providerMessageId: next ?? `wamid.${wamid}`,
          });
        },
      },
      handoff: {
        isHumanMode: () =>
          state.humanUnreadable
            ? Promise.reject(new Error('db'))
            : Promise.resolve(state.human),
      },
      isWindowOpen: () => Promise.resolve(true),
      customerStyle: () => Promise.resolve(state.style),
      ...(withHandler ? { scheduled: handler } : {}),
    },
    {
      clock: () => state.clock,
      random: () => 1,
      newAttemptId: () => {
        attempt += 1;
        return `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
      },
    },
  );
  return { store, acks, sent, state, calls, service, handler };
};

const ACK_ALLOWED = ['PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'STALE'];

describe('ScheduledConversationService through the delivery ledger (unit 14)', () => {
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
  afterEach(() => jest.restoreAllMocks());

  /** S5: nothing a handler logs carries the phone or a wamid. */
  const expectLogsSafe = () => {
    for (const line of logged) {
      expect(line).not.toContain(SENDER);
      expect(line).not.toMatch(/wamid\.[A-Za-z0-9]/);
    }
  };

  describe('conversation.scheduled_reminder', () => {
    it('sends the approved reminder in the branch zone as a BOT message and ACKs PROVIDER_ACCEPTED', async () => {
      const { service, sent, acks, store } = harness();
      await service.accept(reminderItem('r1'));
      expect(sent).toEqual([{ to: SENDER, text: REMINDER_USTED }]);
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.1',
      });
      await expect(store.getDelivery('r1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'REMINDER_SENT',
        ackState: 'ACKED',
      });
      expectLogsSafe();
    });

    it("uses the item's own zone (never a fixed offset)", async () => {
      const { service, sent } = harness();
      const item = reminderItem('r2');
      await service.accept({
        ...item,
        payload: { ...item.payload, timeZone: 'America/Tijuana' },
      });
      expect(sent[0].text).toBe(
        'Le recuerdo que a las 7:00 a. m. una persona del equipo le atiende por aquí.',
      );
    });

    it('one o\'clock reads "a la 1:00 p. m."', async () => {
      const { service, sent } = harness();
      const item = reminderItem('r3');
      await service.accept({
        ...item,
        payload: { ...item.payload, scheduledFor: '2026-11-10T19:00:00.000Z' },
      });
      expect(sent[0].text).toBe(
        'Le recuerdo que a la 1:00 p. m. una persona del equipo le atiende por aquí.',
      );
    });

    it('no zone on the item: the stored appointment zone, else America/Mexico_City', async () => {
      const a = harness();
      a.state.known = {
        scheduledFor: '2026-11-10T15:00:00.000Z',
        scheduleVersion: 1,
        timeZone: 'America/Tijuana',
      };
      const item = reminderItem('r4');
      const noZone = { ...item, payload: { ...item.payload, timeZone: null } };
      await a.service.accept(noZone);
      expect(a.sent[0].text).toContain('a las 7:00 a. m.');

      const b = harness();
      await b.service.accept(noZone);
      expect(b.sent[0].text).toContain('a las 9:00 a. m.');

      const c = harness({ withReader: false });
      await c.service.accept(noZone);
      expect(c.sent[0].text).toContain('a las 9:00 a. m.');
    });

    it('tú: the styled copy', async () => {
      const { service, sent, state } = harness();
      state.style = TU;
      await service.accept(reminderItem('r5'));
      expect(sent[0].text).toBe(
        'Te recuerdo que a las 9:00 a. m. una persona del equipo te atiende por aquí.',
      );
    });

    it('window closed: nothing sent, ACK STALE / WINDOW_CLOSED (never deferred, never a template)', async () => {
      const { service, sent, acks, state, store } = harness();
      state.windowScript = [false];
      await service.accept(reminderItem('r6'));
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('r6')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'WINDOW_CLOSED',
      });
    });

    it('window closes between planning and sending (re-checked right before the send): STALE / WINDOW_CLOSED', async () => {
      const { service, sent, acks, state, store } = harness();
      state.windowScript = [true, false];
      await service.accept(reminderItem('r7'));
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('r7')).resolves.toMatchObject({
        decision: 'WINDOW_CLOSED',
      });
    });

    it("Meta's window error on the send is STALE / WINDOW_CLOSED, not a deferral", async () => {
      const { service, acks, state, store } = harness();
      state.sendScript = [new WhatsappSendError(400, 131047, 'Re-engagement')];
      await service.accept(reminderItem('r8'));
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('r8')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'WINDOW_CLOSED',
      });
    });

    it('HUMAN chat: nothing sent, ACK STALE / HUMAN_SESSION right away (never DEFERRED_HUMAN_SESSION, never held)', async () => {
      const { service, sent, acks, state, store } = harness();
      state.human = true;
      await service.accept(reminderItem('r9'));
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('r9')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'HUMAN_SESSION',
        ackState: 'ACKED',
      });
      // Back to BOT: nothing is replayed.
      state.human = false;
      await service.onCustomerInbound(REF);
      expect(sent).toEqual([]);
      expect(acks).toHaveLength(1);
    });

    it('an unreadable mode fails the item (retried), nothing sent or ACKed', async () => {
      const { service, sent, acks, state, store } = harness();
      state.humanUnreadable = true;
      await expect(service.accept(reminderItem('r10'))).rejects.toThrow();
      expect(sent).toEqual([]);
      expect(acks).toEqual([]);
      await expect(store.getDelivery('r10')).resolves.toMatchObject({
        localState: 'RECEIVED',
      });
    });

    it('the bot holds a newer scheduleVersion: STALE / STALE_SCHEDULE', async () => {
      const { service, sent, acks, state, store } = harness();
      state.known = {
        scheduledFor: '2026-11-11T15:00:00.000Z',
        scheduleVersion: 2,
      };
      await service.accept(reminderItem('r11')); // version 1
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('r11')).resolves.toMatchObject({
        decision: 'STALE_SCHEDULE',
      });
    });

    it('same version but another time than the one the bot holds: STALE / STALE_SCHEDULE', async () => {
      const { service, sent, state, store } = harness();
      state.known = {
        scheduledFor: '2026-11-10T16:00:00.000Z',
        scheduleVersion: 1,
      };
      await service.accept(reminderItem('r12'));
      expect(sent).toEqual([]);
      await expect(store.getDelivery('r12')).resolves.toMatchObject({
        decision: 'STALE_SCHEDULE',
      });
    });

    it('the same instant written another way is not stale', async () => {
      const { service, sent, state } = harness();
      state.known = {
        scheduledFor: '2026-11-10T09:00:00-06:00',
        scheduleVersion: 1,
      };
      await service.accept(reminderItem('r13'));
      expect(sent).toHaveLength(1);
    });

    it.each([
      [
        'an older version',
        { scheduledFor: '2026-11-09T15:00:00.000Z', scheduleVersion: 0 },
      ],
      ['no stored appointment', null],
    ])('%s is not stale: the item is the truth', async (_n, known) => {
      const { service, sent, state } = harness();
      state.known = known;
      await service.accept(reminderItem('r14'));
      expect(sent).toHaveLength(1);
    });

    it('the schedule changes between planning and sending: STALE / STALE_SCHEDULE, nothing sent', async () => {
      const { service, sent, acks, state, store } = harness();
      state.knownScript = [
        null,
        { scheduledFor: '2026-11-11T15:00:00.000Z', scheduleVersion: 2 },
      ];
      await service.accept(reminderItem('r15'));
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('r15')).resolves.toMatchObject({
        decision: 'STALE_SCHEDULE',
      });
    });

    it('an unreadable appointment state fails the item (retried), nothing sent', async () => {
      const { store, state } = harness();
      void state;
      const handler = new ScheduledConversationService({
        store,
        isWindowOpen: () => Promise.resolve(true),
        appointments: {
          knownSchedule: () => Promise.reject(new Error('db')),
        },
        clock: () => NOW,
      });
      const row = (await store.insertDelivery(reminderItem('r16'))).row;
      await expect(
        handler.plan(row, reminderItem('r16') as never),
      ).rejects.toThrow();
    });

    it('the time already passed: STALE / STALE_SCHEDULE (a late reminder only confuses)', async () => {
      const { service, sent, state, store } = harness();
      state.clock = new Date('2026-11-10T15:00:00.000Z');
      await service.accept(reminderItem('r17'));
      expect(sent).toEqual([]);
      await expect(store.getDelivery('r17')).resolves.toMatchObject({
        decision: 'STALE_SCHEDULE',
      });
    });

    it.each(['CANCELLED', 'RESOLVED'] as const)(
      'the request is %s in the registry: STALE / REQUEST_CLOSED',
      async (status) => {
        const { service, sent, store } = harness();
        await store.recordOpenRequest({
          requestId: 'req-r18',
          conversationRef: REF,
          subtype: 'TALK_TO_HUMAN',
        });
        await store.closeRequest('req-r18', status);
        await service.accept(reminderItem('r18'));
        expect(sent).toEqual([]);
        await expect(store.getDelivery('r18')).resolves.toMatchObject({
          decision: 'REQUEST_CLOSED',
        });
      },
    );

    it('an open request in the registry is fine', async () => {
      const { service, sent, store } = harness();
      await store.recordOpenRequest({
        requestId: 'req-r19',
        conversationRef: REF,
        subtype: 'TALK_TO_HUMAN',
      });
      await service.accept(reminderItem('r19'));
      expect(sent).toHaveLength(1);
    });

    it('no conversationRef: STALE / NO_CONVERSATION', async () => {
      const { service, sent, store } = harness();
      await service.accept(reminderItem('r20', { conversationRef: null }));
      expect(sent).toEqual([]);
      await expect(store.getDelivery('r20')).resolves.toMatchObject({
        decision: 'NO_CONVERSATION',
      });
    });

    it('an uncertain send is UNKNOWN / DELIVERY_UNKNOWN and is never resent', async () => {
      const { service, sent, acks, state, store } = harness();
      state.sendScript = [new Error(`socket hang up for ${SENDER}`)];
      await service.accept(reminderItem('r21'));
      expect(acks.map((a) => a.outcome)).toEqual(['DELIVERY_UNKNOWN']);
      await expect(store.getDelivery('r21')).resolves.toMatchObject({
        localState: 'UNKNOWN',
        decision: 'REMINDER_SENT',
      });
      await service.accept(reminderItem('r21'));
      await service.onCustomerInbound(REF);
      expect(sent).toHaveLength(1);
      expectLogsSafe();
    });

    it('a replayed deliveryId is sent and ACKed once', async () => {
      const { service, sent, acks } = harness();
      await service.accept(reminderItem('r22'));
      await service.accept(reminderItem('r22'));
      expect(sent).toHaveLength(1);
      expect(acks).toHaveLength(1);
    });

    it('without a stored-appointment reader the version check is skipped and the reminder is sent', async () => {
      const { service, sent } = harness({ withReader: false });
      await service.accept(reminderItem('r23'));
      expect(sent).toHaveLength(1);
    });
  });

  describe('conversation.rescheduled', () => {
    it('sends the staff-changed notice with the new time in the branch zone', async () => {
      const { service, sent, acks, store } = harness();
      await service.accept(rescheduledItem('s1'));
      expect(sent).toEqual([{ to: SENDER, text: CHANGED_USTED }]);
      expect(acks.map((a) => a.outcome)).toEqual(['PROVIDER_ACCEPTED']);
      await expect(store.getDelivery('s1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'RESCHEDULE_NOTICE',
      });
      expectLogsSafe();
    });

    it('a later day reads "el jueves 12 de noviembre"; tú is styled', async () => {
      const { service, sent, state } = harness();
      state.style = TU;
      const item = rescheduledItem('s2');
      await service.accept({
        ...item,
        payload: { ...item.payload, scheduledFor: '2026-11-12T22:00:00.000Z' },
      });
      expect(sent[0].text).toBe(
        'El equipo cambió tu cita para el jueves 12 de noviembre a las 4:00 p. m.',
      );
    });

    it('window closed → STALE / WINDOW_CLOSED (Q9: never deferred)', async () => {
      const { service, sent, acks, state, store } = harness();
      state.windowScript = [false];
      await service.accept(rescheduledItem('s3'));
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('s3')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'WINDOW_CLOSED',
      });
    });

    it('HUMAN chat → STALE / HUMAN_SESSION', async () => {
      const { service, sent, acks, state, store } = harness();
      state.human = true;
      await service.accept(rescheduledItem('s4'));
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('s4')).resolves.toMatchObject({
        decision: 'HUMAN_SESSION',
      });
    });

    it('superseded by a newer version the bot holds → STALE / STALE_SCHEDULE', async () => {
      const { service, sent, state, store } = harness();
      state.known = {
        scheduledFor: '2026-11-12T15:00:00.000Z',
        scheduleVersion: 3,
      };
      await service.accept(rescheduledItem('s5')); // version 2
      expect(sent).toEqual([]);
      await expect(store.getDelivery('s5')).resolves.toMatchObject({
        decision: 'STALE_SCHEDULE',
      });
    });

    it('the bot already holds exactly this schedule: still told (staff changed it)', async () => {
      const { service, sent, state } = harness();
      state.known = {
        scheduledFor: '2026-11-11T15:30:00.000Z',
        scheduleVersion: 2,
      };
      await service.accept(rescheduledItem('s6'));
      expect(sent).toHaveLength(1);
    });

    it('an uncertain send is DELIVERY_UNKNOWN', async () => {
      const { service, acks, state } = harness();
      state.sendScript = [new Error('timeout')];
      await service.accept(rescheduledItem('s7'));
      expect(acks.map((a) => a.outcome)).toEqual(['DELIVERY_UNKNOWN']);
    });

    it('the new time already passed → STALE / STALE_SCHEDULE', async () => {
      const { service, sent, state, store } = harness();
      state.clock = new Date('2026-11-11T16:00:00.000Z');
      await service.accept(rescheduledItem('s8'));
      expect(sent).toEqual([]);
      await expect(store.getDelivery('s8')).resolves.toMatchObject({
        decision: 'STALE_SCHEDULE',
      });
    });
  });

  it('every ACK of every scheduled outcome is PROVIDER_ACCEPTED, DELIVERY_UNKNOWN or STALE', async () => {
    const run = async (
      item: FeedItem,
      tweak: (h: ReturnType<typeof harness>) => void,
    ) => {
      const h = harness();
      tweak(h);
      await h.service.accept(item);
      return h.acks.map((a) => a.outcome);
    };
    const outcomes = [
      ...(await Promise.all(
        [reminderItem('a1'), rescheduledItem('a2')].flatMap((item) => [
          run(item, () => undefined),
          run(item, (h) => (h.state.windowScript = [false])),
          run(item, (h) => (h.state.human = true)),
          run(item, (h) => (h.state.sendScript = [new Error('x')])),
          run(
            item,
            (h) =>
              (h.state.sendScript = [new WhatsappSendError(400, 131047, 'w')]),
          ),
        ]),
      )),
    ].flat();
    expect(outcomes).toHaveLength(10);
    for (const outcome of outcomes) expect(ACK_ALLOWED).toContain(outcome);
  });

  it('the new decisions are the ledger vocabulary of this slice', () => {
    expect(SCHEDULE_DECISIONS).toEqual([
      'REMINDER_SENT',
      'RESCHEDULE_NOTICE',
      'STALE_SCHEDULE',
    ]);
  });

  it('without a handler wired, scheduled items are the safe STALE / UNKNOWN_TYPE', async () => {
    const { service, sent, acks, store } = harness({ withHandler: false });
    await service.accept(reminderItem('w1'));
    expect(sent).toEqual([]);
    expect(acks.map((a) => a.outcome)).toEqual(['STALE']);
    await expect(store.getDelivery('w1')).resolves.toMatchObject({
      decision: 'UNKNOWN_TYPE',
    });
  });
});
