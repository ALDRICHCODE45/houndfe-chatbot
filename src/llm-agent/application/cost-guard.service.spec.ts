import { Logger } from '@nestjs/common';
import type { LlmSpendStore } from '../domain/llm-spend';
import { InMemoryLlmSpendStore } from '../infrastructure/in-memory-llm-spend.store';
import { CostGuardService, type CostGuardOptions } from './cost-guard.service';

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

  it('fails open and logs an error when the ledger cannot be read or written', async () => {
    const broken: LlmSpendStore = {
      record: jest.fn().mockRejectedValue(new Error('db down')),
      totals: jest.fn().mockRejectedValue(new Error('db down')),
      admitTurn: jest.fn().mockRejectedValue(new Error('db down')),
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
