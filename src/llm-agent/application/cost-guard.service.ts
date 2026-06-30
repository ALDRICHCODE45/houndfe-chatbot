import { Injectable, Logger } from '@nestjs/common';

/**
 * Process-local monthly token-cost guard.
 *
 * Soft-only by design: the spec mandates warn-log thresholds at 80% and
 * 100% of the configured ceiling. The runner MUST keep replying even
 * when the ceiling is exceeded — there is no kill-switch.
 *
 * The aggregate is summed from per-run usage:
 *   aggregate += promptTokens + completionTokens
 *
 * Each threshold (`>=80%`, `>=100%`) emits exactly ONE warn log the
 * first time the aggregate crosses it. Subsequent runs that remain
 * above the threshold do not re-emit. A reset method is exposed for
 * tests (and a future cron reset).
 */
@Injectable()
export class CostGuardService {
  private readonly logger = new Logger(CostGuardService.name);
  private aggregate = 0;
  private hasWarned80 = false;
  private hasWarned100 = false;

  constructor(private readonly ceiling: number) {
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      throw new Error(
        `CostGuardService requires a positive ceiling, got ${ceiling}`,
      );
    }
  }

  /**
   * Records per-turn usage and emits threshold warn logs.
   * NEVER throws — even when the ceiling is exceeded the runner must reply.
   */
  record(usage: { promptTokens: number; completionTokens: number }): void {
    const turn = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    // Defensive: if either field was NaN, treat the turn as 0 rather
    // than poisoning the aggregate (adapter contract should already
    // have defaulted undefined → 0, but be paranoid).
    const safeTurn = Number.isFinite(turn) ? turn : 0;
    this.aggregate += safeTurn;

    if (!this.hasWarned80 && this.aggregate >= this.ceiling * 0.8) {
      this.hasWarned80 = true;
      this.logger.warn(
        `Monthly token usage >=80% of ceiling: aggregate=${this.aggregate}, ceiling=${this.ceiling}`,
      );
    }

    if (!this.hasWarned100 && this.aggregate >= this.ceiling) {
      this.hasWarned100 = true;
      this.logger.warn(
        `Monthly token usage >=100% of ceiling: aggregate=${this.aggregate}, ceiling=${this.ceiling}`,
      );
    }
  }

  /** Current aggregate (tokens used this month). */
  get currentAggregate(): number {
    return this.aggregate;
  }

  /** Test-only: reset the aggregate and the warned-once flags. */
  reset(): void {
    this.aggregate = 0;
    this.hasWarned80 = false;
    this.hasWarned100 = false;
  }
}