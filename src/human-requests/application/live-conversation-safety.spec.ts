import { Logger } from '@nestjs/common';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import {
  FEED_DOWN_AFTER_MS,
  LiveConversationSafety,
  SAFETY_NOTICE,
  type LiveSafetyPorts,
} from './live-conversation-safety';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function build(
  options: {
    syncedAgoMs?: number | null;
    windowOpen?: boolean | Error;
    sendFails?: boolean;
    customerStyle?: LiveSafetyPorts['customerStyle'];
    store?: InMemoryConversationStore;
    wake?: LiveSafetyPorts['wake'];
  } = {},
) {
  const store = options.store ?? new InMemoryConversationStore();
  const mode = new HandoffModeService(store);
  const sent: Array<{ to: string; text: string }> = [];
  const ports: LiveSafetyPorts = {
    feedSyncedAt: jest.fn(async () =>
      options.syncedAgoMs === null
        ? null
        : iso(options.syncedAgoMs ?? 11 * 60_000),
    ),
    listHuman: (limit) => mode.listHuman(limit),
    isWindowOpen: jest.fn(async () => {
      if (options.windowOpen instanceof Error) throw options.windowOpen;
      return options.windowOpen ?? true;
    }),
    claim: (senderId, epoch) => mode.claimSafetyNotice(senderId, epoch),
    send: jest.fn(async (to: string, text: string) => {
      if (options.sendFails) throw new Error('meta down');
      sent.push({ to, text });
    }),
    ...(options.customerStyle === undefined
      ? {}
      : { customerStyle: options.customerStyle }),
    ...(options.wake === undefined ? {} : { wake: options.wake }),
  };
  const safety = new LiveConversationSafety(ports, { clock: () => NOW });
  return { safety, mode, ports, sent, store };
}

describe('LiveConversationSafety (rule 8)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the notice once to a HUMAN conversation with the window open when the feed has been down for more than 10 min', async () => {
    const { safety, mode, sent } = build();
    await mode.applyStarted('5215550001111', 2, 'req-1');
    await expect(safety.run()).resolves.toMatchObject({
      kind: 'down',
      sent: 1,
    });
    expect(sent).toEqual([{ to: '5215550001111', text: SAFETY_NOTICE }]);
    expect(SAFETY_NOTICE).toBe(
      'Tenemos una falla técnica, en cuanto se resuelva le respondemos.',
    );
  });

  it('never repeats it for the same epoch, also after a restart (new instance, same store)', async () => {
    const first = build();
    await first.mode.applyStarted('5215550001111', 2, 'req-1');
    await first.safety.run();
    await first.safety.run();
    expect(first.sent).toHaveLength(1);

    const restarted = build({ store: first.store });
    await expect(restarted.safety.run()).resolves.toMatchObject({ sent: 0 });
    expect(restarted.sent).toHaveLength(0);
  });

  it('sends again for a new epoch of the same conversation', async () => {
    const { safety, mode, sent } = build();
    await mode.applyStarted('5215550001111', 2, 'req-1');
    await safety.run();
    await mode.applyEnded('5215550001111', 2);
    await mode.applyStarted('5215550001111', 3, 'req-2');
    await safety.run();
    expect(sent).toHaveLength(2);
  });

  it('is silent while the feed is healthy (down for exactly 10 min or less)', async () => {
    for (const syncedAgoMs of [0, 30_000, FEED_DOWN_AFTER_MS]) {
      const { safety, mode, sent, ports } = build({ syncedAgoMs });
      await mode.applyStarted('5215550001111', 1, 'req-1');
      await expect(safety.run()).resolves.toEqual({ kind: 'healthy' });
      expect(sent).toHaveLength(0);
      // The cheap path: nothing else is read while healthy.
      expect(ports.isWindowOpen).not.toHaveBeenCalled();
    }
  });

  it('does nothing when the last feed sync is unknown', async () => {
    const { safety, mode, sent } = build({ syncedAgoMs: null });
    await mode.applyStarted('5215550001111', 1, 'req-1');
    await expect(safety.run()).resolves.toEqual({ kind: 'unknown' });
    expect(sent).toHaveLength(0);
  });

  it('does not send when the 24 h window is closed, and does not burn the claim', async () => {
    const closed = build({ windowOpen: false });
    await closed.mode.applyStarted('5215550001111', 1, 'req-1');
    await expect(closed.safety.run()).resolves.toMatchObject({
      kind: 'down',
      sent: 0,
    });
    expect(closed.sent).toHaveLength(0);
    await expect(
      closed.mode.getState('5215550001111'),
    ).resolves.not.toHaveProperty('safetyNoticeEpoch');

    // The customer writes again (window open): the notice may still go.
    const open = build({ store: closed.store });
    await open.safety.run();
    expect(open.sent).toHaveLength(1);
  });

  it('skips a conversation whose window could not be read (never "closed"), keeps going', async () => {
    const { safety, mode, ports, sent } = build();
    await mode.applyStarted('5215550001111', 1, 'req-1');
    await mode.applyStarted('5215550002222', 1, 'req-2');
    (ports.isWindowOpen as jest.Mock)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(true);
    await safety.run();
    expect(sent).toEqual([{ to: '5215550002222', text: SAFETY_NOTICE }]);
  });

  it('only HUMAN conversations get it', async () => {
    const { safety, mode, sent } = build();
    await mode.applyStarted('5215550001111', 1, 'req-1');
    await mode.applyEnded('5215550001111', 1);
    await safety.run();
    expect(sent).toHaveLength(0);
  });

  it('is at-most-once: a failed send is logged (no phone) and not retried', async () => {
    const { safety, mode, sent, ports } = build({ sendFails: true });
    await mode.applyStarted('5215550001111', 1, 'req-1');
    await expect(safety.run()).resolves.toMatchObject({
      kind: 'down',
      sent: 0,
      failed: 1,
    });
    await safety.run();
    expect(ports.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    const calls = warn.mock.calls as unknown[][];
    const logged = calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('safety notice');
    expect(logged).not.toContain('5215550001111');
  });

  it('uses the customer style (tú) through the existing styling', async () => {
    const { safety, mode, sent } = build({
      customerStyle: async () => ({ register: 'tu', emojis: false }) as never,
    });
    await mode.applyStarted('5215550001111', 1, 'req-1');
    await safety.run();
    expect(sent[0].text).toBe(
      'Tenemos una falla técnica, en cuanto se resuelva te respondemos.',
    );
  });

  it('falls back to usted when the style cannot be read', async () => {
    const { safety, mode, sent } = build({
      customerStyle: async () => {
        throw new Error('profile down');
      },
    });
    await mode.applyStarted('5215550001111', 1, 'req-1');
    await safety.run();
    expect(sent[0].text).toBe(SAFETY_NOTICE);
  });

  describe('outbox wake (ordering of bot live notices)', () => {
    it('wakes once per notice, right after a successful send', async () => {
      const order: string[] = [];
      const wake = jest.fn(() => {
        order.push('wake');
      });
      const { safety, mode, ports } = build({ wake });
      (ports.send as jest.Mock).mockImplementation(async () => {
        order.push('send');
      });
      await mode.applyStarted('5215550001111', 2, 'req-1');
      await mode.applyStarted('5215550002222', 1, 'req-2');
      await safety.run();
      expect(wake).toHaveBeenCalledTimes(2);
      expect(order).toEqual(['send', 'wake', 'send', 'wake']);
    });

    it('does not wake for a failed send, a closed window, a lost claim or a healthy feed', async () => {
      const wake = jest.fn();
      const failed = build({ wake, sendFails: true });
      await failed.mode.applyStarted('5215550001111', 2, 'req-1');
      await failed.safety.run();

      const closed = build({ wake, windowOpen: false });
      await closed.mode.applyStarted('5215550001111', 2, 'req-1');
      await closed.safety.run();

      const healthy = build({ wake, syncedAgoMs: 60_000 });
      await healthy.mode.applyStarted('5215550001111', 2, 'req-1');
      await healthy.safety.run();

      const again = build({ wake });
      await again.mode.applyStarted('5215550001111', 2, 'req-1');
      await again.safety.run();
      expect(wake).toHaveBeenCalledTimes(1);
      await again.safety.run(); // same epoch: claim already taken
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it('a waker that throws never counts the notice as failed or stops the pass', async () => {
      const wake = jest.fn(() => {
        throw new Error('wake failed');
      });
      const { safety, mode } = build({ wake });
      await mode.applyStarted('5215550001111', 2, 'req-1');
      await mode.applyStarted('5215550002222', 1, 'req-2');
      await expect(safety.run()).resolves.toEqual({
        kind: 'down',
        sent: 2,
        failed: 0,
      });
      expect(wake).toHaveBeenCalledTimes(2);
    });

    it('works without a waker', async () => {
      const { safety, mode } = build();
      await mode.applyStarted('5215550001111', 2, 'req-1');
      await expect(safety.run()).resolves.toMatchObject({ sent: 1 });
    });
  });
});
