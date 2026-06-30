import { Logger } from '@nestjs/common';
import { CostGuardService } from './cost-guard.service';

/**
 * Unit tests for CostGuardService.
 *
 * Spec scenarios:
 *   - 80% threshold emits ONE warn log and still returns reply.
 *   - 100% threshold emits ONE warn log and still returns reply.
 *   - Never throws when the ceiling is exceeded.
 *   - NaN-safe aggregate (defensive against undefined fields).
 */
describe('CostGuardService', () => {
  const CEILING = 1_000;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function newGuard(ceiling = CEILING): CostGuardService {
    return new CostGuardService(ceiling);
  }

  // ────────────────────────────────────────────────────────────────────
  // Scenario: 80% and 100% thresholds log warn without blocking
  // ────────────────────────────────────────────────────────────────────
  it('does NOT warn below 80%', () => {
    const guard = newGuard();
    guard.record({ promptTokens: 700, completionTokens: 0 }); // 70%
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits exactly ONE >=80% warn log when crossing 80%', () => {
    const guard = newGuard();
    guard.record({ promptTokens: 600, completionTokens: 0 }); // 60%
    expect(warnSpy).not.toHaveBeenCalled();

    guard.record({ promptTokens: 210, completionTokens: 0 }); // 81%
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/>=80%/);
  });

  it('does NOT re-emit the >=80% warn on subsequent turns above 80%', () => {
    const guard = newGuard();
    guard.record({ promptTokens: 600, completionTokens: 0 }); // 60%
    guard.record({ promptTokens: 210, completionTokens: 0 }); // 81% → warn once
    guard.record({ promptTokens: 100, completionTokens: 0 }); // 91% → no new warn

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('emits exactly ONE >=100% warn log when reaching the ceiling', () => {
    const guard = newGuard();
    guard.record({ promptTokens: 600, completionTokens: 0 }); // 60%
    guard.record({ promptTokens: 210, completionTokens: 0 }); // 81% → 80% warn
    guard.record({ promptTokens: 200, completionTokens: 0 }); // 101% → 100% warn

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1]![0]).toMatch(/>=100%/);
  });

  it('does NOT throw when the ceiling is exceeded (soft-only contract)', () => {
    const guard = newGuard();
    expect(() =>
      guard.record({ promptTokens: 999_999, completionTokens: 999_999 }),
    ).not.toThrow();
  });

  it('keeps recording past the ceiling (aggregate keeps growing)', () => {
    const guard = newGuard();
    guard.record({ promptTokens: 2000, completionTokens: 0 });
    expect(guard.currentAggregate).toBe(2000);
    guard.record({ promptTokens: 500, completionTokens: 0 });
    expect(guard.currentAggregate).toBe(2500);
  });

  // ────────────────────────────────────────────────────────────────────
  // Defensive: undefined fields or NaN inputs do not poison the aggregate
  // ────────────────────────────────────────────────────────────────────
  it('treats undefined promptTokens/completionTokens as 0', () => {
    const guard = newGuard();
    // The adapter contract guarantees this is unreachable, but cost guard
    // is the last line of defence.
    expect(() =>
      guard.record({ promptTokens: undefined as unknown as number, completionTokens: undefined as unknown as number }),
    ).not.toThrow();
    expect(guard.currentAggregate).toBe(0);
  });

  it('rejects an invalid ceiling at construction time', () => {
    expect(() => new CostGuardService(0)).toThrow();
    expect(() => new CostGuardService(-1)).toThrow();
    expect(() => new CostGuardService(Number.NaN)).toThrow();
  });

  it('reset() clears the aggregate and the warned-once flags', () => {
    const guard = newGuard();
    guard.record({ promptTokens: 600, completionTokens: 0 });
    guard.record({ promptTokens: 210, completionTokens: 0 }); // 81% → warn
    expect(warnSpy).toHaveBeenCalledTimes(1);

    guard.reset();
    expect(guard.currentAggregate).toBe(0);

    guard.record({ promptTokens: 600, completionTokens: 0 });
    guard.record({ promptTokens: 210, completionTokens: 0 }); // 81% again
    expect(warnSpy).toHaveBeenCalledTimes(2); // new warn after reset
  });
});