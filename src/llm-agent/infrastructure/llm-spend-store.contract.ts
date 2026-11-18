import type { LlmSpendStore, LlmTurnRequest } from '../domain/llm-spend';

/**
 * Shared behaviour of every LlmSpendStore (in-memory and PostgreSQL). Each
 * case uses its own sender and period keys, so the cases are independent on
 * one shared database.
 */
export function runLlmSpendStoreContract(
  label: string,
  make: () => LlmSpendStore | Promise<LlmSpendStore>,
): void {
  describe(`${label} (LlmSpendStore contract)`, () => {
    let seq = 0;
    const fresh = () => {
      seq += 1;
      const day = String(seq).padStart(2, '0');
      return {
        sender: `52155500${String(seq).padStart(5, '0')}`,
        periods: { day: `2031-01-${day}`, month: `2031-${day}` },
      };
    };
    const turn = (
      over: Partial<LlmTurnRequest> & Pick<LlmTurnRequest, 'senderId'>,
    ): LlmTurnRequest => ({
      at: new Date('2031-01-01T12:00:00.000Z'),
      periods: { day: '2031-01-01', month: '2031-01' },
      caps: { dayUsd: 10, monthUsd: 200 },
      limits: { perHour: 3, perDay: 5 },
      ...over,
    });

    it('sums recorded calls per day and per month', async () => {
      const store = await make();
      const { periods } = fresh();
      const caps = { dayUsd: 10, monthUsd: 200 };
      const base = {
        source: 'agent_turn' as const,
        inputTokens: 100,
        outputTokens: 50,
        at: new Date('2031-01-01T12:00:00.000Z'),
        periods,
        caps,
      };
      await store.record({ ...base, usd: 1.25 });
      const second = await store.record({ ...base, usd: 0.5 });
      expect(second.dayUsd).toBeCloseTo(1.75, 6);
      expect(second.monthUsd).toBeCloseTo(1.75, 6);
      const totals = await store.totals(periods);
      expect(totals.dayUsd).toBeCloseTo(1.75, 6);
      expect(totals.monthUsd).toBeCloseTo(1.75, 6);
      // Another day of the same month adds to the month only.
      await store.record({
        ...base,
        usd: 2,
        periods: {
          day: `2030-12-${periods.day.slice(-2)}`,
          month: periods.month,
        },
      });
      const after = await store.totals(periods);
      expect(after.dayUsd).toBeCloseTo(1.75, 6);
      expect(after.monthUsd).toBeCloseTo(3.75, 6);
    });

    it('reports 80% and 100% exactly once per period', async () => {
      const store = await make();
      const { periods } = fresh();
      const caps = { dayUsd: 10, monthUsd: 1000 };
      const rec = (usd: number) =>
        store.record({
          source: 'agent_turn',
          inputTokens: 1,
          outputTokens: 1,
          usd,
          at: new Date('2031-01-01T12:00:00.000Z'),
          periods,
          caps,
        });
      expect(await rec(7)).toMatchObject({ warned80: [], reached100: [] });
      expect(await rec(1.5)).toMatchObject({
        warned80: ['day'],
        reached100: [],
      });
      expect(await rec(0.1)).toMatchObject({ warned80: [], reached100: [] });
      expect(await rec(2)).toMatchObject({ warned80: [], reached100: ['day'] });
      expect(await rec(2)).toMatchObject({ warned80: [], reached100: [] });
    });

    it('admits turns under the limits and counts only admitted turns', async () => {
      const store = await make();
      const { sender, periods } = fresh();
      for (let i = 0; i < 3; i += 1)
        expect(
          await store.admitTurn(turn({ senderId: sender, periods })),
        ).toEqual({ kind: 'allowed' });
      // 4th within the hour exceeds perHour=3: first notice once.
      expect(
        await store.admitTurn(turn({ senderId: sender, periods })),
      ).toEqual({ kind: 'sender_limited', window: 'hour', firstNotice: true });
      expect(
        await store.admitTurn(turn({ senderId: sender, periods })),
      ).toEqual({ kind: 'sender_limited', window: 'hour', firstNotice: false });
      // Another sender is unaffected.
      expect(
        await store.admitTurn(turn({ senderId: `${sender}9`, periods })),
      ).toEqual({ kind: 'allowed' });
    });

    it('resumes when the rolling hour frees, then the day limit applies', async () => {
      const store = await make();
      const { sender, periods } = fresh();
      const at = (iso: string) =>
        store.admitTurn(turn({ senderId: sender, periods, at: new Date(iso) }));
      expect(await at('2031-01-01T10:00:00.000Z')).toEqual({ kind: 'allowed' });
      expect(await at('2031-01-01T10:10:00.000Z')).toEqual({ kind: 'allowed' });
      expect(await at('2031-01-01T10:20:00.000Z')).toEqual({ kind: 'allowed' });
      expect(await at('2031-01-01T10:30:00.000Z')).toMatchObject({
        kind: 'sender_limited',
        window: 'hour',
        firstNotice: true,
      });
      // 11:05: the 10:00 turn left the hour → served again; notice reset.
      expect(await at('2031-01-01T11:05:00.000Z')).toEqual({ kind: 'allowed' });
      // 11:25: only 11:05 is in the hour, 4 turns in the day: one more fits
      // the day (perDay=5).
      expect(await at('2031-01-01T11:25:00.000Z')).toEqual({ kind: 'allowed' });
      // Day now holds 5: the day window refuses, with a fresh first notice.
      expect(await at('2031-01-01T13:00:00.000Z')).toEqual({
        kind: 'sender_limited',
        window: 'day',
        firstNotice: true,
      });
      expect(await at('2031-01-01T13:01:00.000Z')).toMatchObject({
        firstNotice: false,
      });
      // 24 h after the first turns the day frees again.
      expect(await at('2031-01-02T11:30:00.000Z')).toEqual({ kind: 'allowed' });
    });

    it('refuses every turn once a budget is spent, noticing once per sender and period', async () => {
      const store = await make();
      const { sender, periods } = fresh();
      const caps = { dayUsd: 1, monthUsd: 100 };
      await store.record({
        source: 'agent_turn',
        inputTokens: 1,
        outputTokens: 1,
        usd: 1,
        at: new Date('2031-01-01T12:00:00.000Z'),
        periods,
        caps,
      });
      const ask = (senderId: string) =>
        store.admitTurn(turn({ senderId, periods, caps }));
      expect(await ask(sender)).toEqual({
        kind: 'budget_exhausted',
        period: 'day',
        firstNotice: true,
      });
      expect(await ask(sender)).toEqual({
        kind: 'budget_exhausted',
        period: 'day',
        firstNotice: false,
      });
      expect(await ask(`${sender}7`)).toMatchObject({ firstNotice: true });
      // The monthly budget wins over the daily one.
      expect(
        await store.admitTurn(
          turn({
            senderId: sender,
            periods,
            caps: { dayUsd: 1, monthUsd: 1 },
          }),
        ),
      ).toEqual({
        kind: 'budget_exhausted',
        period: 'month',
        firstNotice: true,
      });
      // Budget refusals never count as turns.
      expect(
        await store.admitTurn(
          turn({
            senderId: sender,
            periods,
            caps: { dayUsd: 50, monthUsd: 500 },
          }),
        ),
      ).toEqual({ kind: 'allowed' });
    });
  });
}
