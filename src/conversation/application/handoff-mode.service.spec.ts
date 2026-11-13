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

  it('never sends messages (it only owns the store)', () => {
    expect(Object.getOwnPropertyNames(HandoffModeService.prototype)).toEqual([
      'constructor',
      'isHumanMode',
      'getState',
      'applyStarted',
      'applyEnded',
      'markGreeted',
      'apply',
    ]);
  });
});
