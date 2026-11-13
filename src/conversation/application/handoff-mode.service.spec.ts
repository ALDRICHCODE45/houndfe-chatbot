import { Logger } from '@nestjs/common';
import { InMemoryConversationStore } from '../infrastructure/in-memory-conversation.store';
import { HandoffModeService } from './handoff-mode.service';

/** S7: the entry points the future feed consumer will call. */
describe('HandoffModeService (S7)', () => {
  let store: InMemoryConversationStore;
  let service: HandoffModeService;

  beforeEach(() => {
    store = new InMemoryConversationStore();
    service = new HandoffModeService(store);
  });

  it('is BOT for a conversation that never had a handoff', async () => {
    await expect(service.isHumanMode('wa-1')).resolves.toBe(false);
  });

  it('applyStarted mutes the conversation and applyEnded unmutes it', async () => {
    await expect(service.applyStarted('wa-1', 1, 'req-1')).resolves.toEqual(
      expect.objectContaining({ applied: true }),
    );
    await expect(service.isHumanMode('wa-1')).resolves.toBe(true);
    await expect(service.applyEnded('wa-1', 1)).resolves.toEqual(
      expect.objectContaining({ applied: true }),
    );
    await expect(service.isHumanMode('wa-1')).resolves.toBe(false);
  });

  it('ignores a stale ended order for an older epoch', async () => {
    await service.applyStarted('wa-1', 2, 'req-2');
    await expect(service.applyEnded('wa-1', 1)).resolves.toEqual({
      applied: false,
      reason: 'STALE_EPOCH',
    });
    await expect(service.isHumanMode('wa-1')).resolves.toBe(true);
  });

  it('replays are idempotent', async () => {
    await service.applyStarted('wa-1', 1, 'req-1');
    await expect(service.applyStarted('wa-1', 1, 'req-1')).resolves.toEqual({
      applied: false,
      reason: 'DUPLICATE',
    });
  });

  it('applyStarted with silent records that the greeting of that epoch is skipped', async () => {
    await service.applyStarted('wa-1', 2, 'req-2', { silent: true });
    await expect(service.getState('wa-1')).resolves.toMatchObject({
      mode: 'HUMAN',
      epoch: 2,
      greetingSkippedEpoch: 2,
    });
    await service.applyStarted('wa-3', 2, 'req-2');
    await expect(service.getState('wa-3')).resolves.not.toHaveProperty(
      'greetingSkippedEpoch',
    );
  });

  it('markGreeted records that the greeting of the current epoch went out', async () => {
    await service.applyStarted('wa-1', 2, 'req-2');
    await expect(service.markGreeted('wa-1', 1)).resolves.toBe(false);
    await expect(service.markGreeted('wa-1', 2)).resolves.toBe(true);
    await expect(service.getState('wa-1')).resolves.toMatchObject({
      mode: 'HUMAN',
      epoch: 2,
      greetedEpoch: 2,
    });
  });

  it('markGreeted fails closed when the store cannot record it', async () => {
    const bare = new HandoffModeService({} as never);
    await expect(bare.markGreeted('wa-1', 1)).rejects.toThrow(/handoff/);
  });

  it('claimSafetyNotice is granted once for the current HUMAN epoch', async () => {
    await service.applyStarted('wa-1', 2, 'req-2');
    await expect(service.claimSafetyNotice('wa-1', 2)).resolves.toBe(true);
    await expect(service.claimSafetyNotice('wa-1', 2)).resolves.toBe(false);
    await expect(service.claimSafetyNotice('wa-1', 1)).resolves.toBe(false);
  });

  it('listHuman returns the HUMAN conversations only', async () => {
    await service.applyStarted('wa-2', 1, 'req-b');
    await service.applyStarted('wa-1', 3, 'req-a');
    await service.applyStarted('wa-3', 1, 'req-c');
    await service.applyEnded('wa-3', 1);
    await expect(service.listHuman(10)).resolves.toEqual([
      { senderId: 'wa-1', epoch: 3, requestId: 'req-a' },
      { senderId: 'wa-2', epoch: 1, requestId: 'req-b' },
    ]);
  });

  it('T7 entry points fail closed when the store cannot serve them', async () => {
    const bare = new HandoffModeService({} as never);
    await expect(bare.claimSafetyNotice('wa-1', 1)).rejects.toThrow(/handoff/);
    await expect(bare.listHuman(5)).rejects.toThrow(/handoff/);
  });

  describe('ENDING marker (follow-ups S4)', () => {
    const MIN = 60_000;
    let now: Date;
    let timed: HandoffModeService;
    beforeEach(() => {
      now = new Date('2026-11-12T10:00:00.000Z');
      timed = new HandoffModeService(store, () => now);
    });
    const later = (ms: number) => new Date(now.getTime() + ms);

    it('is not ending nor silenced for a conversation without a marker', async () => {
      await expect(timed.isEnding('wa-1')).resolves.toBe(false);
      await expect(timed.isSilenced('wa-1')).resolves.toBe(false);
      await timed.applyStarted('wa-1', 1, 'req-1');
      await expect(timed.isEnding('wa-1')).resolves.toBe(false);
    });

    it('markEnding silences the bot even after the durable BOT, until cleared', async () => {
      await timed.applyStarted('wa-1', 1, 'req-1');
      await expect(timed.markEnding('wa-1', 1)).resolves.toBe(true);
      await timed.applyEnded('wa-1', 1);
      await expect(timed.isHumanMode('wa-1')).resolves.toBe(false);
      await expect(timed.isEnding('wa-1')).resolves.toBe(true);
      await expect(timed.isSilenced('wa-1')).resolves.toBe(true);
      await expect(timed.clearEnding('wa-1', 1)).resolves.toBe(true);
      await expect(timed.isEnding('wa-1')).resolves.toBe(false);
      await expect(timed.isSilenced('wa-1')).resolves.toBe(false);
    });

    it('is bounded: the default bound is 2 min and the expiry releases', async () => {
      await timed.applyStarted('wa-1', 1, 'req-1');
      await timed.markEnding('wa-1', 1);
      await timed.applyEnded('wa-1', 1);
      now = later(2 * MIN - 1);
      await expect(timed.isEnding('wa-1')).resolves.toBe(true);
      now = later(2 * MIN + 1);
      await expect(timed.isEnding('wa-1')).resolves.toBe(false);
      await expect(timed.isSilenced('wa-1')).resolves.toBe(false);
    });

    it('honours a custom bound', async () => {
      await timed.applyStarted('wa-1', 1, 'req-1');
      await timed.markEnding('wa-1', 1, 10_000);
      now = later(11_000);
      await expect(timed.isEnding('wa-1')).resolves.toBe(false);
    });

    it('logs the expiry once per conversation, without the phone', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await timed.applyStarted('5215550001111', 1, 'req-1');
      await timed.markEnding('5215550001111', 1, 1000);
      now = later(5000);
      await timed.isEnding('5215550001111');
      await timed.isSilenced('5215550001111');
      await timed.isEnding('5215550001111');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('5215550001111');
      // A new marker re-arms the once-log.
      await timed.markEnding('5215550001111', 1, 1000);
      now = later(60_000);
      await timed.isEnding('5215550001111');
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('is persisted: a fresh service over the same store (restart) still sees it', async () => {
      await timed.applyStarted('wa-1', 1, 'req-1');
      await timed.markEnding('wa-1', 1);
      const restarted = new HandoffModeService(store, () => later(MIN));
      await expect(restarted.isEnding('wa-1')).resolves.toBe(true);
      const afterBound = new HandoffModeService(store, () => later(3 * MIN));
      await expect(afterBound.isEnding('wa-1')).resolves.toBe(false);
    });

    it('is not set for a conversation without handoff or for an older epoch', async () => {
      await expect(timed.markEnding('wa-9', 1)).resolves.toBe(false);
      await timed.applyStarted('wa-1', 3, 'req-3');
      await expect(timed.markEnding('wa-1', 2)).resolves.toBe(false);
      await expect(timed.isEnding('wa-1')).resolves.toBe(false);
    });

    it('fails closed when the store cannot serve it', async () => {
      const bare = new HandoffModeService({} as never);
      await expect(bare.markEnding('wa-1', 1)).rejects.toThrow(/handoff/);
      await expect(bare.clearEnding('wa-1', 1)).rejects.toThrow(/handoff/);
      await expect(bare.isEnding('wa-1')).rejects.toThrow(/handoff/);
    });
  });

  it('never sends messages (it only owns the store)', () => {
    expect(Object.getOwnPropertyNames(HandoffModeService.prototype)).toEqual([
      'constructor',
      'isHumanMode',
      'isEnding',
      'isSilenced',
      'endingOf',
      'markEnding',
      'clearEnding',
      'getState',
      'applyStarted',
      'applyEnded',
      'markGreeted',
      'claimSafetyNotice',
      'listHuman',
      'apply',
    ]);
  });
});
