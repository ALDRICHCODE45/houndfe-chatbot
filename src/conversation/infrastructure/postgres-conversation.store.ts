import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AgentTurnCommit } from '../domain/conversation-store';
import { normalizeMinimalCheckoutDraft } from '../domain/minimal-checkout-draft';
import {
  ConversationState,
  ConversationStore,
  isNonEmptyString,
  isStructuralPendingHumanRequest,
  isPendingHumanRequestId,
  isReceiptAmountPointer,
  PendingHumanRequest,
  ReceiptAmountPointer,
} from '../domain/conversation-store';
import { PG_POOL } from '../../database/postgres-pool.provider';

interface ConversationRow {
  sender_id: string;
  last_message_at: Date;
  data: ConversationState['data'];
}

/** Sentinel for “this document cannot be reproduced as JSON”. */
const NON_COMPARABLE = Symbol('non-comparable-expected');

/**
 * A JSON document reproduced from the caller's value without re-reading it.
 * `NON_COMPARABLE` marks a refused subtree.
 */
type CapturedJson =
  | string
  | number
  | boolean
  | null
  | CapturedJson[]
  | { [key: string]: CapturedJson }
  | typeof NON_COMPARABLE;

/**
 * Capture one own value. Anything that would not survive JSON as the SAME
 * document yields `NON_COMPARABLE`: accessors (never invoked), non-enumerable
 * own keys (silently dropped by `JSON.stringify`), exotic prototypes, symbols,
 * functions, `undefined`, bigints and non-finite numbers.
 */
function captureComparableValue(
  node: unknown,
  stack: Set<object>,
): CapturedJson {
  if (node === null) {
    return null;
  }
  if (typeof node === 'string' || typeof node === 'boolean') {
    return node;
  }
  if (typeof node === 'number') {
    return Number.isFinite(node) ? node : NON_COMPARABLE;
  }
  if (typeof node !== 'object') {
    return NON_COMPARABLE;
  }
  // Only a back-edge on the current recursion path is a real cycle; the same
  // object reachable twice acyclicly still forms one finite JSON document.
  if (stack.has(node)) {
    return NON_COMPARABLE;
  }
  stack.add(node);
  try {
    if (Array.isArray(node)) {
      // An array subclass (or any non-ordinary array) can carry an inherited
      // `toJSON` that would rewrite the document, so its own dense indices are
      // not a lossless projection of what the caller would compare. Reject it
      // before the index descriptor pass; ordinary arrays keep raw comparison.
      if (Object.getPrototypeOf(node) !== Array.prototype) {
        return NON_COMPARABLE;
      }
      return captureArray(node as unknown[], stack);
    }
    const prototype = Object.getPrototypeOf(node) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      return NON_COMPARABLE;
    }
    return capturePlainObject(node as Record<string, unknown>, stack);
  } finally {
    stack.delete(node);
  }
}

/**
 * Dense arrays only: own string keys must be exactly indices `0..length-1`
 * plus the matching `length`, each an enumerable data property. Holes would
 * stringify to `null`, and extra or symbol own keys would be dropped, so both
 * are refused. No indexed read is performed, which keeps array element
 * accessors uninvoked.
 */
function captureArray(node: unknown[], stack: Set<object>): CapturedJson {
  const keys = Reflect.ownKeys(node);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(node, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    return NON_COMPARABLE;
  }
  if (
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    return NON_COMPARABLE;
  }
  const length = lengthDescriptor.value;
  if (length < 0 || keys.length !== length + 1) {
    return NON_COMPARABLE;
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      return NON_COMPARABLE;
    }
  }
  const copy: CapturedJson[] = [];
  for (let index = 0; index < length; index += 1) {
    const name = String(index);
    if (!keys.includes(name)) {
      return NON_COMPARABLE;
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, name);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      return NON_COMPARABLE;
    }
    const value = captureComparableValue(descriptor.value, stack);
    if (value === NON_COMPARABLE) {
      return NON_COMPARABLE;
    }
    copy.push(value);
  }
  if (!keys.includes('length')) {
    return NON_COMPARABLE;
  }
  return copy;
}

/**
 * Plain (or null-prototype) objects, captured into a null-prototype copy so a
 * `__proto__` key stays an ordinary data key instead of re-parenting the
 * clone. Values come from the descriptor pass only; nothing is re-read later
 * while stringifying, so a transparent or mutating proxy cannot feed a
 * different document into the CAS binding.
 */
function capturePlainObject(
  node: Record<string, unknown>,
  stack: Set<object>,
): CapturedJson {
  const copy = Object.create(null) as { [key: string]: CapturedJson };
  for (const key of Reflect.ownKeys(node)) {
    if (typeof key !== 'string') {
      return NON_COMPARABLE;
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      return NON_COMPARABLE;
    }
    const value = captureComparableValue(descriptor.value, stack);
    if (value === NON_COMPARABLE) {
      return NON_COMPARABLE;
    }
    Object.defineProperty(copy, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Serialize a RAW expected checkout value for the JSONB equality gate, or
 * `null` when it is not losslessly comparable. Corrupt data is never
 * normalized: `{corrupt:true}`, `null`, JSON scalars and dense corrupt arrays
 * are bound exactly as given, so an absent own key and a present slot holding
 * a corrupt value stay distinct. Hostile reflection (revoked or lying proxies)
 * is caught here and refused as `false` rather than propagating.
 */
function serializeCheckoutExpected(value: unknown): string | null {
  try {
    const captured = captureComparableValue(value, new Set());
    if (captured === NON_COMPARABLE) {
      return null;
    }
    const json = JSON.stringify(captured);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/**
 * Durable (Postgres) implementation of ConversationStore.
 *
 * Schema: see migrations/1700000000000_create-conversation-state.js —
 * one table keyed by sender_id with a jsonb `data` payload. Access is
 * PK-only, so no secondary index is required.
 *
 * **Merge parity (mirrors InMemoryConversationStore byte-identically):**
 * `update()` does a read-modify-write in APP code: `existing ? {...existing, ...patch} : {senderId, ...patch}`.
 * A patch WITHOUT `data` preserves the stored `data`; a patch WITH `data`
 * replaces it wholesale (no JSONB deep merge at the storage layer).
 * The UPSERT then writes the whole merged object via
 * `INSERT ... ON CONFLICT (sender_id) DO UPDATE SET ...`.
 *
 * **timestamptz ↔ ISO 8601:** WRITE binds the ISO string with an
 * explicit `$n::timestamptz` cast so Postgres parses it; READ returns
 * `row.last_message_at.toISOString()` (pg coerces timestamptz → JS Date
 * by default). JS ms ⊆ PG µs, so the value round-trips exact at ms
 * precision.
 *
 * **W2 — knowingly-accepted lost-update window.** The read-then-
 * UPSERT pattern has a window where two concurrent updates could
 * clobber each other's changes. This is acceptable for the v1
 * single-bot-per-sender workload (one writer per sender id) and is
 * explicitly documented here per gate-review W2.
 */
@Injectable()
export class PostgresConversationStore implements ConversationStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async commitMinimalCart(
    senderId: string,
    expected: unknown,
    next: unknown,
    lastMessageAt: string,
  ): Promise<boolean> {
    const absent = expected === undefined;
    const condition = absent
      ? "NOT (conversation_state.data ? 'minimalCart')"
      : "conversation_state.data->'minimalCart' = $4::jsonb";
    const merge = `data = conversation_state.data || jsonb_build_object('minimalCart', $3::jsonb),
      last_message_at = GREATEST(conversation_state.last_message_at, $2::timestamptz)`;
    const sql = absent
      ? `INSERT INTO conversation_state (sender_id, last_message_at, data)
         VALUES ($1, $2::timestamptz, jsonb_build_object('minimalCart', $3::jsonb))
         ON CONFLICT (sender_id) DO UPDATE SET ${merge} WHERE ${condition}`
      : `UPDATE conversation_state SET ${merge} WHERE sender_id = $1 AND ${condition}`;
    const params = [senderId, lastMessageAt, JSON.stringify(next)];
    if (!absent) params.push(JSON.stringify(expected));
    const { rowCount } = await this.pool.query(sql, params);
    return (rowCount ?? 0) === 1;
  }

  /**
   * Durable counterpart of the memory checkout-draft CAS.
   *
   * One parameterized guarded statement, never a read-modify-write and never a
   * retry: `undefined` expected takes the first-contact UPSERT branch that
   * requires the own key to be ABSENT, while any present raw expectation takes
   * an UPDATE-only branch gated on JSONB equality with the caller's exact
   * document. Either branch replaces only the checkout key, merges live
   * siblings, and keeps the newer inbound timestamp via GREATEST.
   *
   * Invalid `next` (sender-bound v1 guard), an invalid timestamp or an
   * expected value that would not survive JSON round-tripping as the SAME
   * document all return `false` before any query, so no row is created or
   * changed and a rejected writer is never authorized to blind-retry.
   */
  async commitMinimalCheckoutDraft(
    senderId: string,
    expected: unknown,
    next: unknown,
    lastMessageAt: string,
  ): Promise<boolean> {
    const copy = normalizeMinimalCheckoutDraft(next, senderId);
    if (
      copy === null ||
      !isNonEmptyString(lastMessageAt) ||
      !Number.isFinite(Date.parse(lastMessageAt))
    ) {
      return false;
    }
    const owned = JSON.stringify(copy);
    if (expected === undefined) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO conversation_state (sender_id, last_message_at, data)
         VALUES ($1, $2::timestamptz, jsonb_build_object('minimalCheckoutDraft', $3::jsonb))
         ON CONFLICT (sender_id) DO UPDATE
           SET data = conversation_state.data || jsonb_build_object('minimalCheckoutDraft', $3::jsonb),
               last_message_at = GREATEST(conversation_state.last_message_at, $2::timestamptz)
           WHERE NOT (conversation_state.data ? 'minimalCheckoutDraft')`,
        [senderId, lastMessageAt, owned],
      );
      return (rowCount ?? 0) === 1;
    }
    const current = serializeCheckoutExpected(expected);
    if (current === null) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE conversation_state
         SET data = conversation_state.data || jsonb_build_object('minimalCheckoutDraft', $3::jsonb),
             last_message_at = GREATEST(conversation_state.last_message_at, $2::timestamptz)
       WHERE sender_id = $1
         AND conversation_state.data->'minimalCheckoutDraft' = $4::jsonb`,
      [senderId, lastMessageAt, owned, current],
    );
    return (rowCount ?? 0) === 1;
  }

  async commitAgentTurn(
    senderId: string,
    turn: AgentTurnCommit,
  ): Promise<boolean> {
    const copy = structuredClone(turn);
    const owned = JSON.stringify({
      messages: copy.messages,
      catalogReferences: copy.catalogReferences,
      agentRevision: randomUUID(),
    });
    const condition = `COALESCE(conversation_state.data->'messages', '[]'::jsonb) = $4::jsonb
      AND (($5::text IS NULL AND NOT (conversation_state.data ? 'agentRevision'))
        OR conversation_state.data->>'agentRevision' = $5::text)`;
    const merge = `last_message_at = GREATEST(conversation_state.last_message_at, $2::timestamptz),
      data = conversation_state.data || $3::jsonb`;
    const sql =
      copy.expected === null
        ? `INSERT INTO conversation_state (sender_id, last_message_at, data)
         VALUES ($1, $2::timestamptz, $3::jsonb)
         ON CONFLICT (sender_id) DO UPDATE SET ${merge} WHERE ${condition}`
        : `UPDATE conversation_state SET ${merge} WHERE sender_id = $1 AND ${condition}`;
    const { rowCount } = await this.pool.query(sql, [
      senderId,
      copy.lastMessageAt,
      owned,
      JSON.stringify(copy.expected?.messages ?? []),
      copy.expected?.revision ?? null,
    ]);
    return (rowCount ?? 0) === 1;
  }

  async setPendingHumanRequest(
    senderId: string,
    marker: PendingHumanRequest,
    lastMessageAt: string,
  ): Promise<boolean> {
    if (
      !isNonEmptyString(senderId) ||
      !isNonEmptyString(lastMessageAt) ||
      !isStructuralPendingHumanRequest(marker)
    ) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, $2::timestamptz,
         jsonb_build_object('pendingHumanRequest', $3::jsonb))
       ON CONFLICT (sender_id) DO UPDATE
         SET last_message_at = EXCLUDED.last_message_at,
             data = conversation_state.data
               || jsonb_build_object('pendingHumanRequest', $3::jsonb)
         WHERE NOT (conversation_state.data ? 'pendingHumanRequest')
            OR conversation_state.data->'pendingHumanRequest' = 'null'::jsonb
            OR (
              jsonb_typeof(conversation_state.data->'pendingHumanRequest') = 'object'
              AND conversation_state.data->'pendingHumanRequest' = $3::jsonb
            )`,
      [senderId, lastMessageAt, JSON.stringify(marker)],
    );
    return (rowCount ?? 0) === 1;
  }

  clearPendingHumanRequest(
    senderId: string,
    requestId: string,
  ): Promise<boolean>;
  clearPendingHumanRequest(
    senderId: string,
    requestId: string,
    lastMessageAt: string,
  ): Promise<boolean>;
  async clearPendingHumanRequest(
    senderId: string,
    requestId: string,
    lastMessageAt?: string,
  ): Promise<boolean> {
    // An explicitly invalid timestamp must not select the two-argument API.
    if (arguments.length === 2) {
      return this.clearCanonicalPendingHumanRequest(senderId, requestId);
    }
    if (
      !isNonEmptyString(senderId) ||
      !isNonEmptyString(requestId) ||
      !isNonEmptyString(lastMessageAt)
    ) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE conversation_state
       SET last_message_at = $3::timestamptz,
           data = jsonb_set(data, '{pendingHumanRequest}', 'null'::jsonb, true)
       WHERE sender_id = $1
         AND jsonb_typeof(data->'pendingHumanRequest') = 'object'
         AND data->'pendingHumanRequest' = jsonb_build_object(
           'requestId', data->'pendingHumanRequest'->'requestId',
           'ref', data->'pendingHumanRequest'->'ref',
           'createdAt', data->'pendingHumanRequest'->'createdAt',
           'customerNotifiedAt', data->'pendingHumanRequest'->'customerNotifiedAt')
         AND jsonb_typeof(data->'pendingHumanRequest'->'requestId') = 'string'
         AND jsonb_typeof(data->'pendingHumanRequest'->'ref') = 'string'
         AND jsonb_typeof(data->'pendingHumanRequest'->'createdAt') = 'string'
         AND jsonb_typeof(data->'pendingHumanRequest'->'customerNotifiedAt') = 'string'
         AND length(data->'pendingHumanRequest'->>'requestId') > 0
         AND length(data->'pendingHumanRequest'->>'ref') > 0
         AND length(data->'pendingHumanRequest'->>'createdAt') > 0
         AND length(data->'pendingHumanRequest'->>'customerNotifiedAt') > 0
         AND data->'pendingHumanRequest'->>'requestId' = $2`,
      [senderId, requestId, lastMessageAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async setReceiptAmountPointer(
    senderId: string,
    pointer: ReceiptAmountPointer,
  ): Promise<boolean> {
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      !isReceiptAmountPointer(pointer)
    ) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE conversation_state
       SET data = jsonb_set(data, '{receiptAmountPointer}',
         jsonb_build_object('receiptMediaId', $2::text,
           'saleId', $3::text, 'receiptVersion', $4::text), true)
       WHERE sender_id = $1 AND (
         NOT (data ? 'receiptAmountPointer') OR (
           jsonb_typeof(data->'receiptAmountPointer') = 'object'
           AND data->'receiptAmountPointer' = jsonb_build_object(
             'receiptMediaId', data->'receiptAmountPointer'->'receiptMediaId',
             'saleId', data->'receiptAmountPointer'->'saleId',
             'receiptVersion', data->'receiptAmountPointer'->'receiptVersion')
           AND jsonb_typeof(data->'receiptAmountPointer'->'receiptMediaId') = 'string'
           AND jsonb_typeof(data->'receiptAmountPointer'->'saleId') = 'string'
           AND jsonb_typeof(data->'receiptAmountPointer'->'receiptVersion') = 'string'
           AND data->'receiptAmountPointer'->>'receiptMediaId' = $2
           AND data->'receiptAmountPointer'->>'saleId' = $3
           AND data->'receiptAmountPointer'->>'receiptVersion' ~ '^[1-9][0-9]*$'
           AND (
             length($4::text) > length(data->'receiptAmountPointer'->>'receiptVersion')
             OR (
               length($4::text) = length(data->'receiptAmountPointer'->>'receiptVersion')
               AND $4::text COLLATE "C" >
                 (data->'receiptAmountPointer'->>'receiptVersion') COLLATE "C"
             )
           )
         )
       )`,
      [
        senderId,
        pointer.receiptMediaId,
        pointer.saleId,
        pointer.receiptVersion,
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  async clearReceiptAmountPointer(
    senderId: string,
    pointer: ReceiptAmountPointer,
  ): Promise<boolean> {
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      !isReceiptAmountPointer(pointer)
    ) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE conversation_state
       SET data = data - 'receiptAmountPointer'
       WHERE sender_id = $1
         AND jsonb_typeof(data->'receiptAmountPointer') = 'object'
         AND data->'receiptAmountPointer' = jsonb_build_object(
           'receiptMediaId', data->'receiptAmountPointer'->'receiptMediaId',
           'saleId', data->'receiptAmountPointer'->'saleId',
           'receiptVersion', data->'receiptAmountPointer'->'receiptVersion')
         AND jsonb_typeof(data->'receiptAmountPointer'->'receiptMediaId') = 'string'
         AND jsonb_typeof(data->'receiptAmountPointer'->'saleId') = 'string'
         AND jsonb_typeof(data->'receiptAmountPointer'->'receiptVersion') = 'string'
         AND data->'receiptAmountPointer'->>'receiptMediaId' = $2
         AND data->'receiptAmountPointer'->>'saleId' = $3
         AND data->'receiptAmountPointer'->>'receiptVersion' ~ '^[1-9][0-9]*$'
         AND data->'receiptAmountPointer'->>'receiptVersion' = $4`,
      [
        senderId,
        pointer.receiptMediaId,
        pointer.saleId,
        pointer.receiptVersion,
      ],
    );
    return (rowCount ?? 0) === 1;
  }

  private async clearCanonicalPendingHumanRequest(
    senderId: string,
    requestId: string,
  ): Promise<boolean> {
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      !isPendingHumanRequestId(requestId)
    ) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE conversation_state
       SET data = jsonb_set(data, '{pendingHumanRequest}', 'null'::jsonb, true)
       WHERE sender_id = $1
         AND jsonb_typeof(data->'pendingHumanRequest') = 'object'
         AND data->'pendingHumanRequest' = jsonb_build_object(
           'requestId', data->'pendingHumanRequest'->'requestId',
           'ref', data->'pendingHumanRequest'->'ref',
           'createdAt', data->'pendingHumanRequest'->'createdAt',
           'customerNotifiedAt', data->'pendingHumanRequest'->'customerNotifiedAt')
         AND jsonb_typeof(data->'pendingHumanRequest'->'requestId') = 'string'
         AND jsonb_typeof(data->'pendingHumanRequest'->'ref') = 'string'
         AND jsonb_typeof(data->'pendingHumanRequest'->'createdAt') = 'string'
         AND jsonb_typeof(data->'pendingHumanRequest'->'customerNotifiedAt') = 'string'
         AND data->'pendingHumanRequest'->>'requestId' = $2
         AND data->'pendingHumanRequest'->>'ref' = 'HF-' || $2
         AND length(data->'pendingHumanRequest'->>'createdAt') > 0
         AND length(data->'pendingHumanRequest'->>'customerNotifiedAt') > 0`,
      [senderId, requestId],
    );
    return (rowCount ?? 0) === 1;
  }

  async get(senderId: string): Promise<ConversationState | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      'SELECT sender_id, last_message_at, data FROM conversation_state WHERE sender_id = $1',
      [senderId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      senderId: row.sender_id,
      lastMessageAt: row.last_message_at.toISOString(),
      data: row.data,
    };
  }

  async create(
    senderId: string,
    state: Omit<ConversationState, 'senderId'>,
  ): Promise<ConversationState> {
    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, $2::timestamptz, $3::jsonb)
       RETURNING sender_id, last_message_at, data`,
      [senderId, state.lastMessageAt, JSON.stringify(state.data)],
    );
    return this.toState(rows[0]);
  }

  async update(
    senderId: string,
    patch: Partial<Omit<ConversationState, 'senderId'>>,
  ): Promise<ConversationState> {
    // Read-modify-write: merge in APP code to mirror InMemory's
    // `{ ...existing, ...patch }` exactly (data REPLACES if patch
    // carries it, PRESERVES if omitted). The CAS-owned
    // `receiptAmountPointer` / `pendingHumanRequest` / `minimalCheckoutDraft`
    // keys are stripped from the patch and the LIVE values re-applied under
    // the row lock.
    const existing = await this.get(senderId);
    const merged = existing
      ? { ...existing, ...patch }
      : { senderId, ...patch };

    if (typeof merged.lastMessageAt !== 'string') {
      throw new Error(
        `ConversationStore.update requires lastMessageAt for senderId: ${senderId}`,
      );
    }
    const data = { ...(merged.data ?? {}) };
    delete data.receiptAmountPointer;
    delete data.pendingHumanRequest;
    delete data.messages;
    delete data.catalogReferences;
    delete data.agentRevision;
    delete data.minimalCart;
    delete data.minimalCheckoutDraft;

    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, $2::timestamptz, $3::jsonb)
       ON CONFLICT (sender_id) DO UPDATE
         SET last_message_at = EXCLUDED.last_message_at,
                 data = CASE
                   WHEN conversation_state.data ? 'receiptAmountPointer'
                   THEN jsonb_set(EXCLUDED.data - 'receiptAmountPointer',
                     '{receiptAmountPointer}', conversation_state.data->'receiptAmountPointer')
                   ELSE EXCLUDED.data - 'receiptAmountPointer'
                 END
                 || CASE WHEN conversation_state.data ? 'pendingHumanRequest'
                   THEN jsonb_build_object('pendingHumanRequest', conversation_state.data->'pendingHumanRequest')
                   ELSE '{}'::jsonb END
                 || (SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
                     FROM jsonb_each(conversation_state.data)
                     WHERE key IN ('messages', 'catalogReferences', 'agentRevision', 'minimalCart', 'minimalCheckoutDraft'))
       RETURNING sender_id, last_message_at, data`,
      [senderId, merged.lastMessageAt, JSON.stringify(data)],
    );
    return this.toState(rows[0]);
  }

  private toState(row: ConversationRow): ConversationState {
    return {
      senderId: row.sender_id,
      lastMessageAt: row.last_message_at.toISOString(),
      data: row.data,
    };
  }
}
