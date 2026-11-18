import { Logger } from '@nestjs/common';
import type { LlmSpendStore } from '../domain/llm-spend';
import { InMemoryLlmSpendStore } from '../infrastructure/in-memory-llm-spend.store';
import {
  CostGuardService,
  NOTICE_RELEASE_BACKOFF_MS,
  type CostGuardOptions,
} from './cost-guard.service';

/**
 * S2 persistent spend cap + S5 per-number limit (cost protection phase 1).
 * The guard prices each call, books it in the shared ledger (store) and
 * answers one admission per LLM turn. A ledger failure fails open.
 */
describe('CostGuardService (persistent spend cap)', () => {
  const NOW = new Date('2026-11-18T18:00:00.000Z'); // 12:00 in Mexico City
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const guard = (
    store: LlmSpendStore = new InMemoryLlmSpendStore(),
    settings: Partial<CostGuardOptions> = {},
  ) =>
    new CostGuardService({
      store,
      clock: () => NOW,
      priceInputUsdPerMtok: 1,
      priceOutputUsdPerMtok: 2,
      dailyBudgetUsd: 1,
      monthlyBudgetUsd: 200,
      senderLimitPerHour: 2,
      senderLimitPerDay: 3,
      ...settings,
    });

  it('defaults to the documented caps and gpt-4o-mini prices', () => {
    expect(new CostGuardService().settings).toEqual({
      priceInputUsdPerMtok: 0.15,
      priceOutputUsdPerMtok: 0.6,
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: 200,
      senderLimitPerHour: 40,
      senderLimitPerDay: 120,
    });
  });

  it('books each call with its source, tokens, priced USD and Mexico City periods', async () => {
    const store = new InMemoryLlmSpendStore();
    const record = jest.spyOn(store, 'record');
    const g = guard(store);
    g.record(
      { promptTokens: 100_000, completionTokens: 50_000 },
      'receipt_vision',
    );
    await g.flush();
    expect(record).toHaveBeenCalledWith({
      source: 'receipt_vision',
      inputTokens: 100_000,
      outputTokens: 50_000,
      usd: 0.2,
      at: NOW,
      periods: { day: '2026-11-18', month: '2026-11' },
      caps: { dayUsd: 1, monthUsd: 200 },
    });
    expect(g.currentAggregate).toBe(150_000);
    await expect(
      store.totals({ day: '2026-11-18', month: '2026-11' }),
    ).resolves.toEqual({
      dayUsd: 0.2,
      monthUsd: 0.2,
    });
  });

  it('warns once at 80% of a period and logs once at 100%', async () => {
    const g = guard();
    g.record({ promptTokens: 700_000, completionTokens: 0 }); // $0.70
    await g.flush();
    expect(warn).not.toHaveBeenCalled();
    g.record({ promptTokens: 150_000, completionTokens: 0 }); // $0.85
    g.record({ promptTokens: 10_000, completionTokens: 0 }); // $0.86
    await g.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String((warn.mock.calls[0] as unknown[])[0])).toMatch(
      />=80%.*daily/,
    );
    g.record({ promptTokens: 200_000, completionTokens: 0 }); // $1.06
    g.record({ promptTokens: 200_000, completionTokens: 0 });
    await g.flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String((warn.mock.calls[1] as unknown[])[0])).toMatch(
      />=100%.*daily/,
    );
  });

  it('stops new LLM calls once a budget is spent (local and shared reads)', async () => {
    const store = new InMemoryLlmSpendStore();
    const g = guard(store);
    expect(g.llmAllowedNow()).toBe(true);
    await expect(g.llmAllowed()).resolves.toBe(true);
    g.record({ promptTokens: 1_000_000, completionTokens: 0 }); // $1 = cap
    await g.flush();
    expect(g.llmAllowedNow()).toBe(false);
    await expect(g.llmAllowed()).resolves.toBe(false);
    // Another process (fresh guard, same ledger) sees it on its next read.
    const other = guard(store);
    expect(other.llmAllowedNow()).toBe(true);
    await expect(other.llmAllowed()).resolves.toBe(false);
    expect(other.llmAllowedNow()).toBe(false);
  });

  it('admits a turn with one store call carrying the caps and limits', async () => {
    const store = new InMemoryLlmSpendStore();
    const admit = jest.spyOn(store, 'admitTurn');
    const g = guard(store);
    await expect(g.admitTurn('5215550001111')).resolves.toEqual({
      kind: 'allowed',
    });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith({
      senderId: '5215550001111',
      at: NOW,
      periods: { day: '2026-11-18', month: '2026-11' },
      caps: { dayUsd: 1, monthUsd: 200 },
      limits: { perHour: 2, perDay: 3 },
    });
    await g.admitTurn('5215550001111');
    await expect(g.admitTurn('5215550001111')).resolves.toEqual({
      kind: 'sender_limited',
      window: 'hour',
      firstNotice: true,
    });
  });

  it('releases the notice of a refusal so the next refusal is a first notice again', async () => {
    const store = new InMemoryLlmSpendStore();
    const g = guard(store);
    const sender = '5215550001111';
    await g.admitTurn(sender);
    await g.admitTurn(sender);
    const refused = await g.admitTurn(sender);
    expect(refused).toMatchObject({ firstNotice: true });
    await g.releaseNotice(sender, refused);
    await expect(g.admitTurn(sender)).resolves.toMatchObject({
      kind: 'sender_limited',
      firstNotice: true,
    });
    // Budget notice: the key of the refused period.
    const spentStore = new InMemoryLlmSpendStore();
    const spent = guard(spentStore);
    spent.record({ promptTokens: 1_000_000, completionTokens: 0 });
    await spent.flush();
    const budget = await spent.admitTurn(sender);
    expect(budget).toEqual({
      kind: 'budget_exhausted',
      period: 'day',
      firstNotice: true,
    });
    const release = jest.spyOn(spentStore, 'releaseNotice');
    await spent.releaseNotice(sender, budget);
    expect(release).toHaveBeenCalledWith(sender, 'budget:day:2026-11-18');
    await expect(spent.admitTurn(sender)).resolves.toMatchObject({
      firstNotice: true,
    });
  });

  it('follow-ups S4: a released notice is in backoff for 15 minutes per sender and notice key', async () => {
    let at = NOW.getTime();
    const g = guard(new InMemoryLlmSpendStore(), { clock: () => new Date(at) });
    const limited = {
      kind: 'sender_limited',
      window: 'hour',
      firstNotice: true,
    } as const;
    const budget = {
      kind: 'budget_exhausted',
      period: 'day',
      firstNotice: true,
    } as const;
    const sender = '5215550001111';
    expect(g.noticeBackoff(sender, limited)).toBe('none');
    await g.releaseNotice(sender, limited);
    expect(g.noticeBackoff(sender, limited)).toBe('within');
    expect(g.noticeBackoff(sender, budget)).toBe('none');
    expect(g.noticeBackoff(`${sender}9`, limited)).toBe('none');
    expect(g.noticeBackoff(sender, { kind: 'allowed' })).toBe('none');
    at += NOTICE_RELEASE_BACKOFF_MS - 1;
    expect(g.noticeBackoff(sender, limited)).toBe('within');
    at += 1;
    expect(g.noticeBackoff(sender, limited)).toBe('elapsed');
    g.noticeDelivered(sender, limited);
    expect(g.noticeBackoff(sender, limited)).toBe('none');
    // Without a store (harnesses) there is never a backoff.
    const bare = new CostGuardService();
    await bare.releaseNotice(sender, limited);
    expect(bare.noticeBackoff(sender, limited)).toBe('none');
  });

  it('never touches the store to release an allowed verdict and fails soft on a release error', async () => {
    const store = new InMemoryLlmSpendStore();
    const release = jest
      .spyOn(store, 'releaseNotice')
      .mockRejectedValue(new Error('db down'));
    const g = guard(store);
    await g.releaseNotice('5215550001111', { kind: 'allowed' });
    expect(release).not.toHaveBeenCalled();
    await expect(
      g.releaseNotice('5215550001111', {
        kind: 'sender_limited',
        window: 'hour',
        firstNotice: true,
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const [logged] = error.mock.calls[0] as [unknown];
    expect(String(logged)).not.toMatch(/5215550001111/);
  });

  it('fails open and logs an error when the ledger cannot be read or written', async () => {
    const broken: LlmSpendStore = {
      record: jest.fn().mockRejectedValue(new Error('db down')),
      totals: jest.fn().mockRejectedValue(new Error('db down')),
      admitTurn: jest.fn().mockRejectedValue(new Error('db down')),
      releaseNotice: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const g = guard(broken);
    await expect(g.admitTurn('5215550001111')).resolves.toEqual({
      kind: 'allowed',
    });
    await expect(g.llmAllowed()).resolves.toBe(true);
    expect(() =>
      g.record({ promptTokens: 1, completionTokens: 1 }),
    ).not.toThrow();
    await g.flush();
    expect(g.llmAllowedNow()).toBe(true);
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('without a store (test harnesses) it allows everything and only counts tokens', async () => {
    const g = new CostGuardService();
    g.record({ promptTokens: 2, completionTokens: 3 });
    await g.flush();
    expect(g.currentAggregate).toBe(5);
    await expect(g.admitTurn('5215550001111')).resolves.toEqual({
      kind: 'allowed',
    });
    await expect(g.llmAllowed()).resolves.toBe(true);
  });

  it('is NaN-safe', async () => {
    const g = guard();
    g.record({ promptTokens: Number.NaN, completionTokens: 4 });
    await g.flush();
    expect(g.currentAggregate).toBe(4);
  });
});
