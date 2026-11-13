import { Logger } from '@nestjs/common';
import type {
  GetConversationStateResult,
  HumanConversationState,
  ListHumanConversationsResult,
  SessionAckResult,
} from '../../chatbot-api/domain/dtos/live-conversation.dto';
import { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { FeedConsumerLock } from '../domain/human-request-feed';
import {
  LiveConversationReconcileWorker,
  type LiveReconcileOptions,
} from './live-conversation-reconcile.worker';

const PHONE_A = '5215550001111';
const PHONE_B = '5215550002222';
const REF_A = `wa:${PHONE_A}`;
const REF_B = `wa:${PHONE_B}`;

const human = (
  ref: string,
  epoch: number,
  requestId = `req-${epoch}`,
): HumanConversationState => ({
  conversationRef: ref,
  mode: 'HUMAN',
  handoffEpoch: epoch,
  sessionState: 'ACTIVE',
  requestId,
  assigneeFirstName: 'Ana',
});

const botState = (epoch: number): GetConversationStateResult => ({
  kind: 'ok',
  mode: 'BOT',
  handoffEpoch: epoch,
  sessionState: null,
  requestId: null,
  assigneeFirstName: null,
});

const humanState = (
  epoch: number,
  requestId: string,
): GetConversationStateResult => ({
  kind: 'ok',
  mode: 'HUMAN',
  handoffEpoch: epoch,
  sessionState: 'ACTIVE',
  requestId,
  assigneeFirstName: null,
});

interface Setup {
  /** Pages returned by listHumanConversations, in order. */
  pages?: ListHumanConversationsResult[];
  /** Answer of getConversationState per ref. */
  states?: Record<string, GetConversationStateResult>;
  ack?: SessionAckResult;
  lockGranted?: boolean;
}

function build(setup: Setup = {}, options: LiveReconcileOptions = {}) {
  const store = new InMemoryConversationStore();
  const mode = new HandoffModeService(store);
  const pages = setup.pages ?? [{ kind: 'ok', items: [], nextCursor: null }];
  let pageIndex = 0;
  const listHumanConversations = jest.fn(async () => {
    const page = pages[Math.min(pageIndex, pages.length - 1)];
    pageIndex += 1;
    return page;
  });
  const getConversationState = jest.fn(
    async (ref: string): Promise<GetConversationStateResult> =>
      setup.states?.[ref] ?? botState(0),
  );
  const ackModes: string[] = [];
  const sessionAck = jest.fn(async (): Promise<SessionAckResult> => {
    // Records what the local mode was when the ack went out.
    ackModes.push((await mode.getState(PHONE_A)).mode);
    return (
      setup.ack ?? {
        kind: 'ok',
        epoch: 1,
        state: 'STARTED',
        sessionState: 'ACTIVE',
      }
    );
  });
  const replay = jest.fn((ref: string) => Promise.resolve(void ref));
  const lock: FeedConsumerLock & { acquired: number; released: number } = {
    acquired: 0,
    released: 0,
    tryAcquire: jest.fn(async () => {
      if (setup.lockGranted === false) return false;
      lock.acquired += 1;
      return true;
    }),
    isHeld: jest.fn(async () => true),
    release: jest.fn(async () => {
      lock.released += 1;
    }),
  };
  const safety = { run: jest.fn(async () => ({ kind: 'healthy' as const })) };
  const worker = new LiveConversationReconcileWorker(
    {
      mode,
      client: { listHumanConversations, getConversationState, sessionAck },
      replay,
      lock,
      safety,
    },
    { random: () => 0.5, ...options },
  );
  return {
    worker,
    mode,
    store,
    listHumanConversations,
    getConversationState,
    sessionAck,
    ackModes,
    replay,
    lock,
    safety,
  };
}

describe('LiveConversationReconcileWorker (rule 9)', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('missed ended (backend wins)', () => {
    it('local HUMAN absent from the backend list and the backend says BOT: durable BOT keeping the higher epoch, replay, no ack, nothing sent', async () => {
      const t = build({ states: { [REF_A]: botState(4) } });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      const result = await t.worker.reconcileAll();
      expect(result).toMatchObject({ kind: 'ok', ended: 1, started: 0 });
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 4,
      });
      expect(t.getConversationState).toHaveBeenCalledTimes(1);
      expect(t.replay).toHaveBeenCalledTimes(1);
      expect(t.replay).toHaveBeenCalledWith(REF_A);
      expect(t.sessionAck).not.toHaveBeenCalled();
    });

    it('ENDING marker (follow-ups S4): set with the revert (before the replay runs), at the reverted epoch, bounded', async () => {
      const t = build({ states: { [REF_A]: botState(4) } });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      let endingAtReplay: boolean | undefined;
      t.replay.mockImplementation(async () => {
        endingAtReplay = await t.mode.isEnding(PHONE_A);
      });
      await t.worker.reconcileAll();
      expect(endingAtReplay).toBe(true);
      const state = await t.mode.getState(PHONE_A);
      expect(state).toMatchObject({ mode: 'BOT', epoch: 4 });
      expect(state.ending?.epoch).toBe(4);
      // Bounded: about 2 minutes ahead, never permanent.
      const ahead = Date.parse(state.ending!.until) - Date.now();
      expect(ahead).toBeGreaterThan(60_000);
      expect(ahead).toBeLessThanOrEqual(2 * 60_000);
      // The ended item's own handling clears it.
      await t.mode.clearEnding(PHONE_A, 4);
      await expect(t.mode.isEnding(PHONE_A)).resolves.toBe(false);
    });

    // R3-reconcile-epoch-mismatch: the ended item will carry the backend
    // epoch, so the marker records the one it covers.
    it('ENDING marker of a revert at the local epoch covers the lower backend epoch', async () => {
      const t = build({ states: { [REF_A]: botState(2) } });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await t.worker.reconcileAll();
      const state = await t.mode.getState(PHONE_A);
      expect(state).toMatchObject({ mode: 'BOT', epoch: 3 });
      expect(state.ending).toMatchObject({ epoch: 3, coversEpoch: 2 });
      // The ended item of epoch 2 clears it.
      await expect(t.mode.clearEnding(PHONE_A, 2)).resolves.toBe(true);
      await expect(t.mode.isEnding(PHONE_A)).resolves.toBe(false);
    });

    // R4-reconcile-marker-full-bound: no ended item will ever come.
    it('sets no marker when the backend does not know the conversation (404 → BOT/0), yet reverts and replays', async () => {
      const t = build({ states: { [REF_A]: botState(0) } });
      await t.mode.applyStarted(PHONE_A, 2, 'req-2');
      let endingAtReplay: boolean | undefined;
      t.replay.mockImplementation(async () => {
        endingAtReplay = await t.mode.isEnding(PHONE_A);
      });
      await t.worker.reconcileAll();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 2,
      });
      await expect(t.mode.getState(PHONE_A)).resolves.not.toHaveProperty(
        'ending',
      );
      expect(endingAtReplay).toBe(false);
      expect(t.replay).toHaveBeenCalledWith(REF_A);
    });

    it('sets no marker when nothing was reverted (already in sync) and one that cannot be set never blocks the revert', async () => {
      const synced = build({ states: { [REF_A]: botState(0) } });
      await synced.worker.reconcileAll();
      await expect(synced.mode.isEnding(PHONE_A)).resolves.toBe(false);

      const t = build({ states: { [REF_A]: botState(4) } });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      jest
        .spyOn(HandoffModeService.prototype, 'markEnding')
        .mockRejectedValueOnce(new Error('db down'));
      const result = await t.worker.reconcileAll();
      expect(result).toMatchObject({ kind: 'ok', ended: 1 });
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 4,
      });
      expect(t.replay).toHaveBeenCalledTimes(1);
    });

    it('an unknown conversation on the backend (404 → BOT/0) still reverts a local HUMAN, keeping the local epoch', async () => {
      const t = build({ states: { [REF_A]: botState(0) } });
      await t.mode.applyStarted(PHONE_A, 2, 'req-2');
      await t.worker.reconcileAll();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 2,
      });
      expect(t.replay).toHaveBeenCalledWith(REF_A);
    });

    it('present in the list with mode BOT is handled the same (single read, no list needed)', async () => {
      const t = build({
        pages: [
          {
            kind: 'ok',
            items: [
              {
                ...human(REF_A, 3),
                mode: 'BOT',
                requestId: null,
                sessionState: null,
              },
            ],
            nextCursor: null,
          },
        ],
      });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await t.worker.reconcileAll();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      expect(t.replay).toHaveBeenCalledTimes(1);
      expect(t.getConversationState).not.toHaveBeenCalled();
    });

    it('present with a different (higher) epoch: the local HUMAN is replaced by the backend HUMAN epoch', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human(REF_A, 5)], nextCursor: null }],
      });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await t.worker.reconcileAll();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 5,
        requestId: 'req-5',
      });
      expect(t.sessionAck).toHaveBeenCalledWith(REF_A, {
        epoch: 5,
        state: 'STARTED',
      });
      expect(t.replay).not.toHaveBeenCalled();
    });

    it('a list that missed a conversation (live read) does not revert it: the confirming read says HUMAN at our epoch', async () => {
      const t = build({ states: { [REF_A]: humanState(3, 'req-3') } });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await t.worker.reconcileAll();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
      expect(t.replay).not.toHaveBeenCalled();
      expect(t.sessionAck).not.toHaveBeenCalled();
    });

    it('does not infer a missed ended from an incomplete list (failed page)', async () => {
      const t = build({
        pages: [
          {
            kind: 'RETRYABLE',
            cause: 'timeout',
            status: null,
            retryAfterSeconds: null,
          },
        ],
      });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'failed',
      });
      await expect(t.mode.isHumanMode(PHONE_A)).resolves.toBe(true);
      expect(t.getConversationState).not.toHaveBeenCalled();
      expect(t.replay).not.toHaveBeenCalled();
    });

    it('does not infer it from a list cut by the page bound, and reads state for none of them', async () => {
      const t = build(
        {
          pages: [
            { kind: 'ok', items: [], nextCursor: 'c1' },
            { kind: 'ok', items: [], nextCursor: 'c2' },
          ],
        },
        { maxPages: 2 },
      );
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'ok',
        truncated: true,
      });
      expect(t.listHumanConversations).toHaveBeenCalledTimes(2);
      expect(t.getConversationState).not.toHaveBeenCalled();
      await expect(t.mode.isHumanMode(PHONE_A)).resolves.toBe(true);
    });

    it('bounds the confirming reads per run (maxStateReads) and leaves the rest for the next run', async () => {
      const t = build({}, { maxStateReads: 1 });
      await t.mode.applyStarted(PHONE_A, 1, 'req-a');
      await t.mode.applyStarted(PHONE_B, 1, 'req-b');
      await t.worker.reconcileAll();
      expect(t.getConversationState).toHaveBeenCalledTimes(1);
      const humans = await t.mode.listHuman(10);
      expect(humans).toHaveLength(1);
      await t.worker.reconcileAll();
      await expect(t.mode.listHuman(10)).resolves.toHaveLength(0);
    });

    it('a failing confirming read changes nothing and stops confirming', async () => {
      const t = build({
        states: {
          [REF_A]: {
            kind: 'RETRYABLE',
            cause: 'network',
            status: null,
            retryAfterSeconds: null,
          },
        },
      });
      await t.mode.applyStarted(PHONE_A, 1, 'req-a');
      await t.mode.applyStarted(PHONE_B, 1, 'req-b');
      await t.worker.reconcileAll();
      expect(t.getConversationState).toHaveBeenCalledTimes(1);
      await expect(t.mode.listHuman(10)).resolves.toHaveLength(2);
    });
  });

  describe('missed started (backend wins)', () => {
    it('backend HUMAN with a higher epoch: mute durably, then session-ack STARTED, no greeting, no replay', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human(REF_A, 3)], nextCursor: null }],
      });
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'ok',
        started: 1,
        ended: 0,
      });
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
        requestId: 'req-3',
        // L14 c: a later `started` item of this epoch must not greet.
        greetingSkippedEpoch: 3,
      });
      expect(t.sessionAck).toHaveBeenCalledTimes(1);
      expect(t.sessionAck).toHaveBeenCalledWith(REF_A, {
        epoch: 3,
        state: 'STARTED',
      });
      // The mute was durable BEFORE the ack went out.
      expect(t.ackModes).toEqual(['HUMAN']);
      expect(t.replay).not.toHaveBeenCalled();
      expect(t.getConversationState).not.toHaveBeenCalled();
    });

    it('a refused ack (409/404) is a reconcile signal: logged, never retried, state kept', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human(REF_A, 3)], nextCursor: null }],
        ack: {
          kind: 'STALE_EPOCH',
          currentEpoch: 4,
          mode: 'HUMAN',
          sessionState: 'ACTIVE',
        },
      });
      await t.worker.reconcileAll();
      expect(t.sessionAck).toHaveBeenCalledTimes(1);
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
    });

    it('a throwing ack never fails the run', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human(REF_A, 3)], nextCursor: null }],
      });
      t.sessionAck.mockRejectedValueOnce(new Error('boom'));
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'ok',
        started: 1,
      });
    });

    it('a conversation we already ended at that epoch is never muted again', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human(REF_A, 3)], nextCursor: null }],
      });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await t.mode.applyEnded(PHONE_A, 3);
      await t.worker.reconcileAll();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      expect(t.sessionAck).not.toHaveBeenCalled();
    });

    it('a backend HUMAN without a requestId is ignored (cannot be stored)', async () => {
      const t = build({
        pages: [
          {
            kind: 'ok',
            items: [{ ...human(REF_A, 3), requestId: null }],
            nextCursor: null,
          },
        ],
      });
      await t.worker.reconcileAll();
      await expect(t.mode.isHumanMode(PHONE_A)).resolves.toBe(false);
      expect(t.sessionAck).not.toHaveBeenCalled();
    });

    it('skips list items whose ref is not a WhatsApp ref', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human('mail:x', 3)], nextCursor: null }],
      });
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'ok',
        started: 0,
      });
    });
  });

  describe('S1 performance', () => {
    it('in sync: one bulk call, no per-conversation read, no writes', async () => {
      const t = build({
        pages: [
          { kind: 'ok', items: [human(REF_A, 3, 'req-3')], nextCursor: null },
        ],
      });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      const setHandoff = jest.spyOn(t.store, 'applyHandoff');
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'ok',
        started: 0,
        ended: 0,
      });
      expect(t.listHumanConversations).toHaveBeenCalledTimes(1);
      expect(t.getConversationState).not.toHaveBeenCalled();
      expect(setHandoff).not.toHaveBeenCalled();
      expect(t.sessionAck).not.toHaveBeenCalled();
    });

    it('nothing local is HUMAN and the backend list is empty: a single bulk call and nothing else', async () => {
      const t = build();
      await expect(t.worker.reconcileAll()).resolves.toEqual({ kind: 'idle' });
      expect(t.listHumanConversations).toHaveBeenCalledTimes(1);
      expect(t.getConversationState).not.toHaveBeenCalled();
      expect(t.sessionAck).not.toHaveBeenCalled();
      expect(t.replay).not.toHaveBeenCalled();
    });

    it('one bulk call per page, following the cursor, with the page limit', async () => {
      const t = build(
        {
          pages: [
            { kind: 'ok', items: [human(REF_A, 1)], nextCursor: 'c1' },
            { kind: 'ok', items: [human(REF_B, 1)], nextCursor: null },
          ],
        },
        { pageLimit: 50 },
      );
      await t.worker.reconcileAll();
      expect(t.listHumanConversations.mock.calls).toEqual([
        [{ limit: 50 }],
        [{ limit: 50, cursor: 'c1' }],
      ]);
      await expect(t.mode.listHuman(10)).resolves.toHaveLength(2);
    });

    it('a rate limited page stops the run without changing anything', async () => {
      const t = build({
        pages: [{ kind: 'RATE_LIMITED', retryAfterSeconds: 30 }],
      });
      await t.mode.applyStarted(PHONE_A, 1, 'req-a');
      await expect(t.worker.reconcileAll()).resolves.toMatchObject({
        kind: 'failed',
      });
      await expect(t.mode.isHumanMode(PHONE_A)).resolves.toBe(true);
    });
  });

  describe('reconcileOne (refused ack, batch hint)', () => {
    it('started → ack NOT_FOUND → reconcileOne: the local HUMAN is reverted to BOT with no farewell, then held deliveries are replayed', async () => {
      const t = build({
        states: { [REF_A]: botState(0) },
        ack: { kind: 'NOT_FOUND' },
      });
      // What LiveConversationService.started did: durable HUMAN first…
      await t.mode.applyStarted(PHONE_A, 2, 'req-2');
      // …then the ack was refused, so it asks to reconcile this conversation.
      await expect(t.worker.reconcileOne(REF_A)).resolves.toMatchObject({
        kind: 'ended',
      });
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 2,
      });
      expect(t.replay).toHaveBeenCalledWith(REF_A);
      // Rule 9: missed ended applies without a farewell (and without an ack).
      expect(t.sessionAck).not.toHaveBeenCalled();
    });

    it('reads one state, applies a missed started the same way as the bulk path', async () => {
      const t = build({ states: { [REF_A]: humanState(7, 'req-7') } });
      await expect(t.worker.reconcileOne(REF_A)).resolves.toMatchObject({
        kind: 'started',
      });
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 7,
      });
      expect(t.sessionAck).toHaveBeenCalledWith(REF_A, {
        epoch: 7,
        state: 'STARTED',
      });
    });

    it('in sync: reads once and writes nothing', async () => {
      const t = build({ states: { [REF_A]: humanState(2, 'req-2') } });
      await t.mode.applyStarted(PHONE_A, 2, 'req-2');
      await expect(t.worker.reconcileOne(REF_A)).resolves.toMatchObject({
        kind: 'in_sync',
      });
      expect(t.replay).not.toHaveBeenCalled();
    });

    it('a failing read leaves the state alone and reports failed (never throws)', async () => {
      const t = build({
        states: { [REF_A]: { kind: 'UNAUTHORIZED' } },
      });
      await t.mode.applyStarted(PHONE_A, 2, 'req-2');
      await expect(t.worker.reconcileOne(REF_A)).resolves.toMatchObject({
        kind: 'failed',
      });
      await expect(t.mode.isHumanMode(PHONE_A)).resolves.toBe(true);
      t.getConversationState.mockRejectedValueOnce(new Error('boom'));
      await expect(t.worker.reconcileOne(REF_A)).resolves.toMatchObject({
        kind: 'failed',
      });
    });

    it('a replay that throws does not undo the durable BOT', async () => {
      const t = build({ states: { [REF_A]: botState(2) } });
      await t.mode.applyStarted(PHONE_A, 2, 'req-2');
      t.replay.mockRejectedValueOnce(new Error('replay down'));
      await expect(t.worker.reconcileOne(REF_A)).resolves.toMatchObject({
        kind: 'ended',
      });
      await expect(t.mode.isHumanMode(PHONE_A)).resolves.toBe(false);
    });

    it('an invalid ref is ignored without any call', async () => {
      const t = build();
      await expect(t.worker.reconcileOne('nope')).resolves.toMatchObject({
        kind: 'ignored',
      });
      expect(t.getConversationState).not.toHaveBeenCalled();
    });

    it('concurrent calls for one conversation share a single read', async () => {
      const t = build({ states: { [REF_A]: botState(1) } });
      await Promise.all([
        t.worker.reconcileOne(REF_A),
        t.worker.reconcileOne(REF_A),
      ]);
      expect(t.getConversationState).toHaveBeenCalledTimes(1);
    });
  });

  describe('messages:batch hint', () => {
    it('a hint that disagrees with local state schedules ONE single-conversation read; a hint that agrees costs no read', async () => {
      const t = build({ states: { [REF_A]: humanState(3, 'req-3') } });
      t.worker.hint(REF_A, { mode: 'BOT', handoffEpoch: 0 });
      await t.worker.idle();
      expect(t.getConversationState).not.toHaveBeenCalled();

      t.worker.hint(REF_A, { mode: 'HUMAN', handoffEpoch: 3 });
      await t.worker.idle();
      expect(t.getConversationState).toHaveBeenCalledTimes(1);
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
    });

    it('a disagreeing epoch alone (both BOT) also reconciles', async () => {
      const t = build({ states: { [REF_A]: botState(4) } });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      await t.mode.applyEnded(PHONE_A, 3);
      t.worker.hint(REF_A, { mode: 'BOT', handoffEpoch: 4 });
      await t.worker.idle();
      await expect(t.mode.getState(PHONE_A)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 4,
      });
      expect(t.replay).not.toHaveBeenCalled();
    });

    it('is debounced per conversation, not globally, and expires', async () => {
      let now = 1_000_000;
      const t = build(
        { states: { [REF_A]: botState(0), [REF_B]: botState(0) } },
        { clock: () => now, hintDebounceMs: 30_000 },
      );
      for (const ref of [REF_A, REF_A, REF_A])
        t.worker.hint(ref, { mode: 'HUMAN', handoffEpoch: 9 });
      await t.worker.idle();
      expect(t.getConversationState).toHaveBeenCalledTimes(1);

      t.worker.hint(REF_B, { mode: 'HUMAN', handoffEpoch: 9 });
      await t.worker.idle();
      expect(t.getConversationState).toHaveBeenCalledTimes(2);

      t.worker.hint(REF_A, { mode: 'HUMAN', handoffEpoch: 9 });
      await t.worker.idle();
      expect(t.getConversationState).toHaveBeenCalledTimes(2);

      now += 30_001;
      t.worker.hint(REF_A, { mode: 'HUMAN', handoffEpoch: 9 });
      await t.worker.idle();
      expect(t.getConversationState).toHaveBeenCalledTimes(3);
    });

    it('never throws, whatever the hint or the stores do', async () => {
      const t = build();
      jest
        .spyOn(t.mode, 'getState')
        .mockRejectedValueOnce(new Error('corrupt'));
      expect(() =>
        t.worker.hint(REF_A, { mode: 'HUMAN', handoffEpoch: 1 }),
      ).not.toThrow();
      expect(() =>
        t.worker.hint('garbage', { mode: 'HUMAN', handoffEpoch: 1 }),
      ).not.toThrow();
      await t.worker.idle();
      expect(t.getConversationState).not.toHaveBeenCalled();
    });
  });

  describe('tick: no overlap, safety, and the timer', () => {
    it('never overlaps in one process: a tick while another runs is busy', async () => {
      let release!: () => void;
      const t = build();
      t.listHumanConversations.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ kind: 'ok', items: [], nextCursor: null });
          }),
      );
      const first = t.worker.tick();
      await new Promise((r) => setImmediate(r));
      await expect(t.worker.tick()).resolves.toEqual({ kind: 'busy' });
      release();
      await expect(first).resolves.toMatchObject({ kind: 'ran' });
      expect(t.listHumanConversations).toHaveBeenCalledTimes(1);
    });

    it('never overlaps across replicas: without the advisory lock nothing is called', async () => {
      const t = build({ lockGranted: false });
      await expect(t.worker.tick()).resolves.toEqual({
        kind: 'locked_elsewhere',
      });
      expect(t.listHumanConversations).not.toHaveBeenCalled();
      expect(t.safety.run).not.toHaveBeenCalled();
    });

    it('releases the lock after a run, also when the run fails', async () => {
      const t = build({ pages: [{ kind: 'UNAUTHORIZED' }] });
      await t.worker.tick();
      expect(t.lock.acquired).toBe(1);
      expect(t.lock.released).toBe(1);
      t.listHumanConversations.mockRejectedValueOnce(new Error('boom'));
      await t.worker.tick();
      expect(t.lock.released).toBe(2);
    });

    it('a lock that throws is logged and skipped', async () => {
      const t = build();
      (t.lock.tryAcquire as jest.Mock).mockRejectedValueOnce(new Error('db'));
      await expect(t.worker.tick()).resolves.toEqual({ kind: 'lock_failed' });
    });

    it('runs the safety notice check after the first run, even when the reconcile read fails (backend down)', async () => {
      const t = build({
        pages: [
          {
            kind: 'RETRYABLE',
            cause: 'network',
            status: null,
            retryAfterSeconds: null,
          },
        ],
      });
      await t.worker.tick();
      // Start-up run: the feed consumer may not have synced yet.
      expect(t.safety.run).not.toHaveBeenCalled();
      await expect(t.worker.tick()).resolves.toMatchObject({
        kind: 'ran',
        reconcile: { kind: 'failed' },
      });
      expect(t.safety.run).toHaveBeenCalledTimes(1);
    });

    it('a failing safety check never breaks the worker', async () => {
      const t = build();
      t.safety.run.mockRejectedValue(new Error('db'));
      await t.worker.tick();
      await expect(t.worker.tick()).resolves.toMatchObject({ kind: 'ran' });
    });

    it('runs at start-up and then every ~5 min with jitter, and stop cancels the timer', async () => {
      jest.useFakeTimers();
      const t = build(
        {},
        {
          intervalMs: 300_000,
          jitterRatio: 0.2,
          startupJitterMs: 5_000,
          random: () => 0,
        },
      );
      t.worker.start();
      t.worker.start(); // idempotent
      // random 0 → startup jitter 0, interval = 300 s * (1 - 0.2).
      await jest.advanceTimersByTimeAsync(0);
      expect(t.listHumanConversations).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(239_999);
      expect(t.listHumanConversations).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.listHumanConversations).toHaveBeenCalledTimes(2);
      await t.worker.stop();
      await jest.advanceTimersByTimeAsync(600_000);
      expect(t.listHumanConversations).toHaveBeenCalledTimes(2);
      t.worker.start(); // never restarts after stop
      await jest.advanceTimersByTimeAsync(600_000);
      expect(t.listHumanConversations).toHaveBeenCalledTimes(2);
    });
  });

  describe('S7: no phone in logs', () => {
    it('never logs the phone or the full ref, in any path', async () => {
      const t = build({
        pages: [{ kind: 'ok', items: [human(REF_B, 3)], nextCursor: null }],
        states: { [REF_A]: botState(4) },
        ack: {
          kind: 'STALE_EPOCH',
          currentEpoch: 5,
          mode: 'HUMAN',
          sessionState: 'ACTIVE',
        },
      });
      await t.mode.applyStarted(PHONE_A, 3, 'req-3');
      t.replay.mockRejectedValueOnce(
        new Error(`replay failed for ${REF_A} ${PHONE_A}`),
      );
      await t.worker.reconcileAll();
      t.getConversationState.mockRejectedValueOnce(
        new Error(`GET ${REF_B} failed`),
      );
      await t.worker.reconcileOne(REF_B);
      const calls = [
        ...(warn.mock.calls as unknown[][]),
        ...(log.mock.calls as unknown[][]),
      ];
      const all = calls.map((c) => String(c[0])).join('\n');
      expect(all.length).toBeGreaterThan(0);
      for (const secret of [PHONE_A, PHONE_B, REF_A, REF_B])
        expect(all).not.toContain(secret);
    });
  });
});
