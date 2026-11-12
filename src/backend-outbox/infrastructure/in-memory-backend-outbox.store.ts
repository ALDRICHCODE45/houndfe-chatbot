import {
  assertEnqueueInput,
  laneForKind,
  truncateError,
  type BackendOutboxCompletion,
  type BackendOutboxEnqueueInput,
  type BackendOutboxEnqueueResult,
  type BackendOutboxEntry,
  type BackendOutboxStore,
  type ClaimedBackendOutboxEntry,
} from '../domain/backend-outbox';

const copy = <T extends BackendOutboxEntry>(entry: T): T => ({
  ...entry,
  payload: structuredClone(entry.payload),
});

/** Seq counters and heads are keyed per (conversation, lane). */
const laneKey = (
  entry: Pick<BackendOutboxEntry, 'conversationRef' | 'kind'>,
): string => `${entry.conversationRef}|${laneForKind(entry.kind)}`;

/** Test/dev adapter with the same head-of-line and lease semantics as the
 * Postgres store; time comes from the injected clock. */
export class InMemoryBackendOutboxStore implements BackendOutboxStore {
  private readonly rows: BackendOutboxEntry[] = [];
  private readonly nextSeq = new Map<string, number>();
  private nextId = 1;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  enqueue(
    input: BackendOutboxEnqueueInput,
  ): Promise<BackendOutboxEnqueueResult> {
    try {
      assertEnqueueInput(input);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const existing = this.rows.find(
      (row) => row.idempotencyKey === input.idempotencyKey,
    );
    if (existing)
      return Promise.resolve({ entry: copy(existing), created: false });
    const key = laneKey(input);
    const seq = this.nextSeq.get(key) ?? 1;
    this.nextSeq.set(key, seq + 1);
    const now = new Date(this.clock());
    const entry: BackendOutboxEntry = {
      id: String(this.nextId++),
      conversationRef: input.conversationRef,
      seq,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      payload: structuredClone(input.payload),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(now.getTime() + Math.max(0, input.delayMs ?? 0)),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: now,
      doneAt: null,
    };
    this.rows.push(entry);
    return Promise.resolve({ entry: copy(entry), created: true });
  }

  claimHeads(
    limit: number,
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedBackendOutboxEntry[]> {
    const now = this.clock();
    const heads = new Map<string, BackendOutboxEntry>();
    for (const row of this.rows) {
      if (row.status !== 'PENDING' && row.status !== 'IN_FLIGHT') continue;
      const key = laneKey(row);
      const head = heads.get(key);
      if (!head || row.seq < head.seq) heads.set(key, row);
    }
    const due = [...heads.values()]
      .filter((row) =>
        row.status === 'PENDING'
          ? row.nextAttemptAt.getTime() <= now
          : (row.leaseExpiresAt?.getTime() ?? 0) <= now,
      )
      .sort(
        (a, b) =>
          a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
          Number(a.id) - Number(b.id),
      )
      .slice(0, Math.max(0, limit));
    return Promise.resolve(
      due.map((row) => {
        row.status = 'IN_FLIGHT';
        row.leaseOwner = owner;
        row.leaseExpiresAt = new Date(now + leaseMs);
        return copy(row as ClaimedBackendOutboxEntry);
      }),
    );
  }

  claimRun(
    head: ClaimedBackendOutboxEntry,
    owner: string,
    leaseMs: number,
    maxRows: number,
  ): Promise<ClaimedBackendOutboxEntry[]> {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1)
      return Promise.resolve([]);
    const headRow = this.rows.find((r) => r.id === head.id);
    if (
      !headRow ||
      headRow.status !== 'IN_FLIGHT' ||
      headRow.leaseOwner !== head.leaseOwner ||
      headRow.leaseExpiresAt?.getTime() !== head.leaseExpiresAt.getTime()
    )
      return Promise.resolve([]);
    const now = this.clock();
    const lane = laneForKind(headRow.kind);
    const run: BackendOutboxEntry[] = [headRow];
    const followers = this.rows
      .filter(
        (row) =>
          row.conversationRef === headRow.conversationRef &&
          row.seq > headRow.seq &&
          (row.status === 'PENDING' || row.status === 'IN_FLIGHT') &&
          laneForKind(row.kind) === lane,
      )
      .sort((a, b) => a.seq - b.seq);
    for (const row of followers) {
      if (run.length >= maxRows) break;
      const due =
        row.status === 'PENDING'
          ? row.nextAttemptAt.getTime() <= now
          : (row.leaseExpiresAt?.getTime() ?? 0) <= now;
      if (row.kind !== headRow.kind || !due) break;
      run.push(row);
    }
    const leaseExpiresAt = new Date(now + leaseMs);
    return Promise.resolve(
      run.map((row) => {
        row.status = 'IN_FLIGHT';
        row.leaseOwner = owner;
        row.leaseExpiresAt = leaseExpiresAt;
        return copy(row as ClaimedBackendOutboxEntry);
      }),
    );
  }

  completeMany(items: readonly BackendOutboxCompletion[]): Promise<boolean[]> {
    return Promise.all(
      items.map((item) => {
        switch (item.outcome) {
          case 'DONE':
            return this.markDone(item.entry);
          case 'RETRY':
            return this.reschedule(item.entry, item.delayMs, item.error);
          case 'DEAD':
            return this.markDead(item.entry, item.error);
        }
      }),
    );
  }

  markDone(entry: ClaimedBackendOutboxEntry): Promise<boolean> {
    return this.complete(entry, (row) => {
      row.status = 'DONE';
      row.doneAt = new Date(this.clock());
    });
  }

  reschedule(
    entry: ClaimedBackendOutboxEntry,
    delayMs: number,
    error: string,
  ): Promise<boolean> {
    return this.complete(entry, (row) => {
      row.status = 'PENDING';
      row.nextAttemptAt = new Date(this.clock() + Math.max(0, delayMs));
      row.lastError = truncateError(error);
    });
  }

  markDead(entry: ClaimedBackendOutboxEntry, error: string): Promise<boolean> {
    return this.complete(entry, (row) => {
      row.status = 'DEAD';
      row.lastError = truncateError(error);
    });
  }

  purgeDone(olderThanMs: number, limit: number): Promise<number> {
    const cutoff = this.clock() - olderThanMs;
    const victims = this.rows
      .filter(
        (row) =>
          row.status === 'DONE' &&
          row.doneAt !== null &&
          row.doneAt.getTime() < cutoff,
      )
      .sort((a, b) => a.doneAt!.getTime() - b.doneAt!.getTime())
      .slice(0, Math.max(0, limit));
    for (const victim of victims)
      this.rows.splice(this.rows.indexOf(victim), 1);
    return Promise.resolve(victims.length);
  }

  /** Detached copies of every row, in insertion order (tests). */
  snapshot(): BackendOutboxEntry[] {
    return this.rows.map(copy);
  }

  private complete(
    entry: ClaimedBackendOutboxEntry,
    apply: (row: BackendOutboxEntry) => void,
  ): Promise<boolean> {
    const row = this.rows.find((r) => r.id === entry.id);
    if (
      !row ||
      row.status !== 'IN_FLIGHT' ||
      row.leaseOwner !== entry.leaseOwner ||
      row.leaseExpiresAt?.getTime() !== entry.leaseExpiresAt.getTime()
    )
      return Promise.resolve(false);
    row.attempts += 1;
    row.leaseOwner = null;
    row.leaseExpiresAt = null;
    apply(row);
    return Promise.resolve(true);
  }
}
