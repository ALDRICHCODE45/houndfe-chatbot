/** Spec S7 end-to-end run of the human request feed against a DEV backend:
 * create → staff resolve/cancel → feed item → outcome ACK. Drives the REAL
 * ChatbotApiHttpClient, HumanRequestFeedConsumer (`runOnce`, no advisory
 * lock) and HumanRequestDeliveryService over the in-memory feed store. The
 * WhatsApp sender is a fake that only records sends: no real message is ever
 * sent and the chatbot Postgres DB is never touched. WRITES DEV DATA on the
 * backend (a request and the outcome ACKs). Never prints the service key or
 * request headers. `--phase recovery` only reads the 5c recovery route
 * (`GET /chatbot-api/requests?status=open`, every page) and prints a masked
 * summary: no ACK, no write. `--phase clarification` (unit 10 T2) consumes a
 * staff clarification reply for a request created earlier and drives the
 * real transcript + mirror stack: see `runClarification`. See
 * scripts/e2e/README.md. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { of } from 'rxjs';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';
import type {
  CreateHumanRequestInput,
  FeedItem,
  OpenHumanRequest,
  ReadFeedResult,
  RecordDeliveryOutcomeResult,
} from '../../src/chatbot-api/domain/dtos/human-requests.dto';
import { HumanRequestDeliveryService } from '../../src/human-requests/application/human-request-delivery.service';
import { HumanRequestFeedConsumer } from '../../src/human-requests/application/human-request-feed.consumer';
import {
  maskConversationRef,
  type FeedConsumerLock,
} from '../../src/human-requests/domain/human-request-feed';
import { BackendOutboxDrainWorker } from '../../src/backend-outbox/application/backend-outbox-drain.worker';
import { BackendOutboxService } from '../../src/backend-outbox/application/backend-outbox.service';
import { InMemoryBackendOutboxStore } from '../../src/backend-outbox/infrastructure/in-memory-backend-outbox.store';
import { RoutingBackendOutboxDelivery } from '../../src/backend-outbox/infrastructure/routing-backend-outbox.delivery';
import { MirrorDeliveryGate } from '../../src/conversation-mirror/application/mirror-delivery-gate';
import { MirrorMediaService } from '../../src/conversation-mirror/application/mirror-media.service';
import { MirrorMessagesDelivery } from '../../src/conversation-mirror/application/mirror-messages.delivery';
import { MirrorStatusesDelivery } from '../../src/conversation-mirror/application/mirror-statuses.delivery';
import type { MirrorMetaDownloader } from '../../src/conversation-mirror/domain/mirror-media';
import { InMemoryMirrorMediaCacheStore } from '../../src/conversation-mirror/infrastructure/in-memory-mirror-media-cache.store';
import { LinkMirrorFetcher } from '../../src/conversation-mirror/infrastructure/link-mirror-fetcher';
import { TranscriptRecorder } from '../../src/conversation-transcript/application/transcript-recorder';
import { InMemoryTranscriptStore } from '../../src/conversation-transcript/infrastructure/in-memory-transcript.store';
import { MetaWhatsappSender } from '../../src/whatsapp/infrastructure/meta-whatsapp.sender';
import { InMemoryHumanRequestFeedStore } from '../../src/human-requests/infrastructure/in-memory-human-request-feed.store';
import { DEFAULT_CUSTOMER_STYLE } from '../../src/llm-agent/domain/customer-style';
import type {
  OutboundText,
  SendResult,
} from '../../src/whatsapp/domain/whatsapp-sender.port';

const BASE_URL = process.env.CHATBOT_API_BASE_URL ?? 'http://localhost:3003';
const BRANCH_ID =
  process.env.CHATBOT_API_BRANCH_ID ?? 'ced6cc10-a037-4f41-92af-ee69bbb51c8b';
const TOKEN_FILE = '/tmp/houndfe-dev-bot-token.txt';
const TAIL_PAGE_LIMIT = 50;
const MAX_CONSECUTIVE_FAILURES = 5;

type Phase = 'create' | 'consume' | 'all' | 'recovery' | 'clarification';

interface Args {
  phase: Phase;
  phone: string;
  minutes: number;
  minutesGiven: boolean;
  after: string | null;
  withRestock: string | null;
  requests: string[];
  updatedSince: string | null;
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: human-requests-feed-e2e [--phase create|consume|all|recovery|clarification] [--phone 5550001111] [--minutes 15] [--after <cursor>] [--with-restock <productId>] [--request <requestId>]... [--updated-since <ISO ms Z>]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    phase: 'all',
    phone: '5550001111',
    minutes: 15,
    minutesGiven: false,
    after: null,
    withRestock: null,
    requests: [],
    updatedSince: null,
  };
  const rest = argv.filter((arg) => arg !== '--');
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--'))
      usage(`missing value for ${flag}`);
    i += 1;
    switch (flag) {
      case '--phase':
        if (
          value !== 'create' &&
          value !== 'consume' &&
          value !== 'all' &&
          value !== 'recovery' &&
          value !== 'clarification'
        )
          usage(`invalid --phase ${value}`);
        args.phase = value;
        break;
      case '--phone':
        if (!/^[0-9]{10}$/.test(value)) usage('--phone must be 10 digits');
        args.phone = value;
        break;
      case '--minutes':
        args.minutes = Number(value);
        if (!Number.isFinite(args.minutes) || args.minutes <= 0)
          usage('--minutes must be a positive number');
        args.minutesGiven = true;
        break;
      case '--after':
        args.after = value;
        break;
      case '--with-restock':
        args.withRestock = value;
        break;
      case '--request':
        args.requests.push(value);
        break;
      case '--updated-since':
        args.updatedSince = value;
        break;
      default:
        usage(`unknown argument ${flag}`);
    }
  }
  if (args.phase === 'clarification') {
    if (args.requests.length !== 1)
      usage('--phase clarification needs exactly one --request <id>');
    if (!args.minutesGiven) args.minutes = 10;
  }
  return args;
}

function line(step: string, outcome: string, fields: Record<string, unknown>) {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  process.stdout.write(
    `[${step}] ${outcome}${rendered ? ` ${rendered}` : ''}\n`,
  );
}

/** Never prints raw errors: an Axios error carries the request headers. */
function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof ChatbotApiError)
    return {
      error: error.name,
      status: error.statusCode,
      errorCode: error.errorCode,
      message: error.message,
    };
  return { error: error instanceof Error ? error.name : typeof error };
}

/* ---- Observation: real HTTP status of every outcome ACK ---- */

interface AckHttp {
  status: number | null;
  code: string | null;
}

const OUTCOME_URL = /\/chatbot-api\/deliveries\/([^/]+)\/outcome$/;
const ackHttp = new Map<string, AckHttp>();

function recordAckHttp(url: string | undefined, http: AckHttp) {
  const match = url === undefined ? null : OUTCOME_URL.exec(url);
  if (match) ackHttp.set(decodeURIComponent(match[1]), http);
}

function bodyCode(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const code = record.code ?? record.errorCode;
  return typeof code === 'string' ? code : null;
}

/* ---- Fakes for the local ports ---- */

interface FakeSend {
  to: string;
  text: string;
  providerMessageId: string;
}

class FakeWhatsappSender {
  readonly sends: FakeSend[] = [];

  sendText(message: OutboundText): Promise<SendResult> {
    const providerMessageId = `wamid.e2e-${randomUUID()}`;
    this.sends.push({ ...message, providerMessageId });
    return Promise.resolve({ providerMessageId });
  }
}

/** The e2e run is the only consumer: no Postgres advisory lock. */
const noopLock: FeedConsumerLock = {
  tryAcquire: () => Promise.resolve(true),
  isHeld: () => Promise.resolve(true),
  release: () => Promise.resolve(),
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serviceKey = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (serviceKey === '') usage(`empty token file ${TOKEN_FILE}`);

  if (args.phase === 'clarification') {
    await runClarification(args, serviceKey);
    return;
  }

  const http = axios.create();
  http.interceptors.response.use(
    (response: AxiosResponse) => {
      recordAckHttp(response.config.url, {
        status: response.status,
        code: null,
      });
      return response;
    },
    (error: AxiosError) => {
      recordAckHttp(error.config?.url, {
        status: error.response?.status ?? null,
        code: bodyCode(error.response?.data),
      });
      return Promise.reject(error);
    },
  );
  const config = new ConfigService({
    chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
  });
  const client = new ChatbotApiHttpClient(new HttpService(http), config);

  const store = new InMemoryHumanRequestFeedStore();
  const sender = new FakeWhatsappSender();
  const ackResults = new Map<string, RecordDeliveryOutcomeResult | string>();
  const delivery = new HumanRequestDeliveryService({
    store,
    client: {
      recordDeliveryOutcome: async (deliveryId, input) => {
        try {
          const result = await client.recordDeliveryOutcome(deliveryId, input);
          ackResults.set(deliveryId, result);
          return result;
        } catch (error) {
          ackResults.set(
            deliveryId,
            error instanceof Error ? error.name : 'error',
          );
          throw error;
        }
      },
      listPendingDeliveries: (filter) => client.listPendingDeliveries(filter),
    },
    sender,
    handoff: { isHumanMode: () => Promise.resolve(false) },
    isWindowOpen: () => Promise.resolve(true),
    customerStyle: () => Promise.resolve(DEFAULT_CUSTOMER_STYLE),
  });

  line('config', 'ok', {
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    phase: args.phase,
    phone: `…${args.phone.slice(-4)}`,
    minutes: args.minutes,
  });

  if (args.phase === 'recovery') {
    await recovery(client, args.updatedSince);
    return;
  }

  // Tail first (phase all), so the created request's items come after it.
  let start: string | null = args.after;
  if (args.phase !== 'create' && start === null) {
    start = await readTail(client);
    line('tail', 'ok', { cursor: start });
  }

  const watched = new Set(args.requests);
  if (args.phase !== 'consume') {
    for (const id of await createRequests(client, args)) watched.add(id);
  }
  if (args.phase === 'create') return;

  await consume(args, client, store, delivery, start, watched, ackResults);

  /* ---- Summary ---- */
  const rows = handledRows;
  const outcomes: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.ackOutcome ?? 'none'}/${row.ackState ?? 'none'}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  line('summary', 'items', { handled: rows.length, ackOutcomes: outcomes });
  for (const send of sender.sends)
    line('summary', 'fake send', {
      to: `…${send.to.slice(-4)}`,
      providerMessageId: send.providerMessageId,
      text: send.text,
    });
  const failedAcks = rows.filter(
    (row) => ackHttp.get(row.deliveryId)?.status !== 200 && row.ackOutcome,
  );
  for (const row of failedAcks) {
    const httpResult = ackHttp.get(row.deliveryId);
    line('summary', 'non-200 ACK', {
      deliveryId: row.deliveryId,
      outcome: row.ackOutcome,
      status: httpResult?.status ?? null,
      code: httpResult?.code ?? null,
      result: renderAckResult(ackResults.get(row.deliveryId)),
    });
  }
  const missing = [...watched].filter((id) => !handledRequests.has(id));
  if (missing.length > 0)
    line('summary', 'requests without a handled item', { missing });
  if (failedAcks.length > 0 || missing.length > 0) process.exitCode = 1;
}

/** 5c recovery route, every page, read only (nothing is ACKed). Prints
 *  counts and masked conversation refs; never the phone or payload text. */
async function recovery(
  client: ChatbotApiHttpClient,
  updatedSince: string | null,
): Promise<void> {
  const requests: OpenHumanRequest[] = [];
  const nextCursors = new Set<string>();
  let page: string | undefined;
  let pages = 0;
  for (;;) {
    const result = await client.listOpenRequests({
      ...(updatedSince === null ? {} : { updatedSince }),
      ...(page === undefined ? {} : { cursor: page }),
      limit: 50,
    });
    if (result.kind === 'RATE_LIMITED') {
      line('recovery', 'rate limited', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
      await sleep((result.retryAfterSeconds ?? 1) * 1000);
      continue;
    }
    if (result.kind === 'VALIDATION_ERROR') {
      line('recovery', 'FAILED', { result });
      process.exitCode = 1;
      return;
    }
    pages += 1;
    nextCursors.add(result.nextCursor);
    requests.push(...result.items);
    if (result.nextPage === null) break;
    page = result.nextPage;
  }
  const byStatus: Record<string, number> = {};
  const byDeferral: Record<string, number> = {};
  let pending = 0;
  let resume: string | null = null;
  for (const request of requests) {
    byStatus[request.status] = (byStatus[request.status] ?? 0) + 1;
    pending += request.pendingDeliveries.length;
    for (const item of request.pendingDeliveries) {
      const key =
        item.type === 'unknown' ? 'unknown' : (item.deferredReason ?? 'none');
      byDeferral[key] = (byDeferral[key] ?? 0) + 1;
    }
    const after = request.undeliveredResumeAfter;
    if (after !== null && (resume === null || after < resume)) resume = after;
    line('recovery', 'request', {
      id: request.id,
      folio: request.folio,
      kind: request.kind,
      subtype: request.subtype,
      status: request.status,
      conversation: maskConversationRef(request.conversationRef),
      pendingDeliveries: request.pendingDeliveries.map((item) => ({
        cursor: item.cursor,
        deliveryId: item.deliveryId,
        type: item.type === 'unknown' ? `unknown:${item.rawType}` : item.type,
        deferredReason:
          item.type === 'unknown' ? null : (item.deferredReason ?? null),
      })),
      undeliveredTruncated: request.undeliveredTruncated,
      undeliveredResumeAfter: request.undeliveredResumeAfter,
    });
  }
  const [nextCursor] = nextCursors;
  line('recovery', 'summary', {
    pages,
    requests: requests.length,
    distinctIds: new Set(requests.map((request) => request.id)).size,
    byStatus,
    pendingDeliveries: pending,
    byDeferredReason: byDeferral,
    truncated: requests.filter((request) => request.undeliveredTruncated)
      .length,
    nextCursor: nextCursor ?? null,
    nextCursorStableAcrossPages: nextCursors.size <= 1,
    resumeFrom:
      resume !== null && nextCursor !== undefined && resume < nextCursor
        ? resume
        : (nextCursor ?? null),
  });
}

/** Reads with waitSeconds 0 until a page is empty; returns the last cursor. */
async function readTail(client: ChatbotApiHttpClient): Promise<string | null> {
  let cursor: string | null = null;
  for (;;) {
    const page = await client.readFeed({
      ...(cursor === null ? {} : { after: cursor }),
      limit: TAIL_PAGE_LIMIT,
      waitSeconds: 0,
    });
    if (page.kind === 'RATE_LIMITED') {
      await sleep((page.retryAfterSeconds ?? 1) * 1000);
      continue;
    }
    if (page.kind === 'CURSOR_EXPIRED')
      throw new Error('CURSOR_EXPIRED while reading the feed tail');
    if (page.nextCursor !== '') cursor = page.nextCursor;
    if (page.items.length === 0) return cursor;
  }
}

async function createRequests(
  client: ChatbotApiHttpClient,
  args: Args,
): Promise<string[]> {
  const customer = { phoneCountryCode: '52', phone: args.phone };
  const conversationRef = `wa:521${args.phone}`;
  const ids: string[] = [];
  const create = async (step: string, input: CreateHumanRequestInput) => {
    const result = await client.createHumanRequest(input);
    if (result.kind !== 'ok') {
      line(step, 'FAILED', { result });
      throw new Error(`${step} failed: ${result.kind}`);
    }
    const created = result.response;
    line(step, 'ok', {
      status: result.status,
      outcome: created.outcome,
      requestId: created.id,
      folio: created.folio,
      requestStatus: created.status,
      mergedIntoId: created.mergedIntoId,
    });
    const id = created.mergedIntoId ?? created.id;
    if (id !== null) ids.push(id);
  };

  const sourceRequestId = randomUUID();
  await create('create.unknown_question', {
    sourceRequestId,
    subtype: 'UNKNOWN_QUESTION',
    customer,
    conversationRef,
    lastCustomerMessageAt: new Date().toISOString(),
    summary: 'E2E: ¿sirve para cachorros?',
  });

  if (args.withRestock !== null) {
    const stock = await client.getStock(args.withRestock);
    const restockSourceId = randomUUID();
    await create('create.restock', {
      sourceRequestId: restockSourceId,
      subtype: 'RESTOCK',
      customer,
      conversationRef,
      lastCustomerMessageAt: new Date().toISOString(),
      summary: `E2E: resurtido de ${stock.name}`.slice(0, 140),
      detail: {
        sourceRequestId: restockSourceId,
        type: 'RESTOCK',
        productId: stock.productId,
        productName: stock.name,
        variantId: null,
        sku: null,
        requestedQuantity: 1,
        observedStockAtRequest: stock.stock.quantity,
        stockObservedAt:
          stock.stock.quantity === null ? null : new Date().toISOString(),
        supersedesDecisionId: null,
      },
    });
  }
  return ids;
}

interface HandledRow {
  deliveryId: string;
  ackOutcome: string | null;
  ackState: string | null;
}

const handledRows: HandledRow[] = [];
const handledRequests = new Set<string>();

function renderAckResult(
  result: RecordDeliveryOutcomeResult | string | undefined,
): string | null {
  if (result === undefined) return null;
  return typeof result === 'string' ? `threw ${result}` : result.kind;
}

async function consume(
  args: Args,
  client: ChatbotApiHttpClient,
  store: InMemoryHumanRequestFeedStore,
  delivery: HumanRequestDeliveryService,
  start: string | null,
  watched: Set<string>,
  ackResults: Map<string, RecordDeliveryOutcomeResult | string>,
): Promise<void> {
  await store.saveCursor(start);
  let cursorExpired = false;
  const consumer = new HumanRequestFeedConsumer({
    store,
    client: {
      readFeed: async (options): Promise<ReadFeedResult> => {
        const result = await client.readFeed(options);
        // Restarting from the oldest item would ACK unrelated dev deliveries.
        if (result.kind === 'CURSOR_EXPIRED') cursorExpired = true;
        return result;
      },
      // The 5c recovery would ACK unrelated dev deliveries: use
      // `--phase recovery` to inspect it read-only instead.
      listOpenRequests: () =>
        Promise.reject(new Error('recovery disabled in the e2e run')),
    },
    delivery: {
      accept: async (item: FeedItem) => {
        await delivery.accept(item);
        await report(item);
      },
      abandon: (item, reason) => delivery.abandon(item, reason),
    },
    lock: noopLock,
  });

  const report = async (item: FeedItem) => {
    const row = await store.getDelivery(item.deliveryId);
    const requestId = item.type === 'unknown' ? null : item.requestId;
    if (requestId !== null) handledRequests.add(requestId);
    handledRows.push({
      deliveryId: item.deliveryId,
      ackOutcome: row?.ackOutcome ?? null,
      ackState: row?.ackState ?? null,
    });
    const httpResult = ackHttp.get(item.deliveryId);
    line('item', 'handled', {
      cursor: item.cursor,
      type: item.type === 'unknown' ? `unknown:${item.rawType}` : item.type,
      requestId,
      deliveryId: item.deliveryId,
      decision: row?.decision ?? null,
      localState: row?.localState ?? null,
      ackOutcome: row?.ackOutcome ?? null,
      ackState: row?.ackState ?? null,
      ackHttp: httpResult?.status ?? null,
      ackCode: httpResult?.code ?? null,
      ackResult: renderAckResult(ackResults.get(item.deliveryId)),
      watched: requestId !== null && watched.has(requestId),
    });
  };

  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    line('consume', 'interrupted', {});
    void consumer.stop();
  });

  const deadline = Date.now() + args.minutes * 60_000;
  const done = () =>
    watched.size > 0 && [...watched].every((id) => handledRequests.has(id));
  line('consume', 'start', { after: start, watched: [...watched] });
  let failures = 0;
  while (!interrupted && !done() && Date.now() < deadline) {
    try {
      const result = await consumer.runOnce();
      failures = 0;
      if (cursorExpired) {
        line('consume', 'CURSOR_EXPIRED', {
          note: 'stopping instead of restarting from the oldest item',
        });
        break;
      }
      // As the maintenance worker does: retry due PENDING ACKs.
      const retried = await delivery.sweepAcks();
      if (retried > 0) line('consume', 'ACK sweep', { retried });
      if (result.kind === 'rate_limited') await sleep(result.retryAfterMs);
    } catch (error) {
      if (cursorExpired) {
        line('consume', 'CURSOR_EXPIRED', {
          note: 'stopping; inspect with --phase recovery',
        });
        break;
      }
      failures += 1;
      line('consume', 'page failed', { failures, ...describeError(error) });
      if (failures >= MAX_CONSECUTIVE_FAILURES) break;
      await sleep(Math.min(30_000, 1_000 * 2 ** (failures - 1)));
    }
  }
  line('consume', 'stop', {
    reason: interrupted
      ? 'interrupted'
      : done()
        ? 'all watched requests handled'
        : cursorExpired
          ? 'cursor expired'
          : failures >= MAX_CONSECUTIVE_FAILURES
            ? 'too many failures'
            : 'time limit',
    cursor: await store.readCursor(),
  });
  await consumer.stop();
}

/* ======================================================================
 * --phase clarification (unit 10 T2): staff reply → send → ACK → mirror
 * ====================================================================== */

const DRAIN_BOUND_MS = 180_000;
const MESSAGES_ROUTE = /\/chatbot-api\/conversations\/[^/]+\/messages:batch$/;

interface MirrorCall {
  status: number | null;
  code: string | null;
  messages: Array<{
    waMessageId: string;
    direction: string;
    type: string;
    hasStaffReplyId: boolean;
  }>;
}

/** The serialized request body of a messages:batch call, reduced to what the
 *  report needs. Never keeps text, headers or the conversation ref. */
function summarizeMirrorBody(data: unknown): MirrorCall['messages'] {
  let body: unknown = data;
  if (typeof data === 'string') {
    try {
      body = JSON.parse(data);
    } catch {
      return [];
    }
  }
  if (typeof body !== 'object' || body === null) return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  return messages.map((raw: unknown) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    return {
      waMessageId: text(m.waMessageId),
      direction: text(m.direction),
      type: text(m.type),
      hasStaffReplyId: text(m.staffReplyId) !== '',
    };
  });
}

/**
 * Consumes the staff clarification reply of ONE request created earlier,
 * sends it through the REAL `MetaWhatsappSender` (its HTTP transport is a
 * stub returning `wamid.e2e-<runId>-<n>`: Meta is never called), records it
 * through the REAL `TranscriptRecorder` (in-memory transcript store, in-memory
 * backend outbox) and, once the item is handled and ACKed, drains that outbox
 * with the real drain worker and mirror adapters against the dev backend.
 *
 * The sender is the real class on purpose: `staffReplyId` reaches the
 * transcript through `MetaWhatsappSender.send` → `recordTranscript`
 * (`details.staffReplyId`) and `mirrorPayload`, so the run exercises exactly
 * the production hand-over instead of a copy of it. Only the transport
 * (`HttpService.post`) and the ConfigService values are fake.
 */
async function runClarification(args: Args, serviceKey: string): Promise<void> {
  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const [requestId] = args.requests;
  const watched = new Set([requestId]);
  const conversationRef = `wa:521${args.phone}`;
  const masked = maskConversationRef(conversationRef);

  /* ---- one counted HTTP client: ACK statuses + messages:batch bodies ---- */
  const mirrorCalls: MirrorCall[] = [];
  const http = axios.create();
  http.interceptors.response.use(
    (response: AxiosResponse) => {
      recordAckHttp(response.config.url, {
        status: response.status,
        code: null,
      });
      if (MESSAGES_ROUTE.test(response.config.url ?? ''))
        mirrorCalls.push({
          status: response.status,
          code: null,
          messages: summarizeMirrorBody(response.config.data),
        });
      return response;
    },
    (error: AxiosError) => {
      recordAckHttp(error.config?.url, {
        status: error.response?.status ?? null,
        code: bodyCode(error.response?.data),
      });
      if (MESSAGES_ROUTE.test(error.config?.url ?? ''))
        mirrorCalls.push({
          status: error.response?.status ?? null,
          code: bodyCode(error.response?.data),
          messages: summarizeMirrorBody(error.config?.data),
        });
      return Promise.reject(error);
    },
  );
  const client = new ChatbotApiHttpClient(
    new HttpService(http),
    new ConfigService({
      chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
    }),
  );

  /* ---- transcript → in-memory outbox (production recorder) ---- */
  const outboxStore = new InMemoryBackendOutboxStore();
  const outbox = new BackendOutboxService(outboxStore);
  const recorder = new TranscriptRecorder(
    new InMemoryTranscriptStore(),
    undefined,
    outbox,
  );

  /* ---- the real Meta sender over a stub transport ---- */
  const metaPosts: Array<{ to: string; text: string; staffReplyId: boolean }> =
    [];
  let wamidCounter = 0;
  const transport = new HttpService();
  (transport as { post: unknown }).post = (
    _url: string,
    payload: { to: string; text?: { body?: string } },
  ) => {
    wamidCounter += 1;
    metaPosts.push({
      to: payload.to,
      text: payload.text?.body ?? '',
      staffReplyId: JSON.stringify(payload).includes('staffReplyId'),
    });
    return of({
      data: { messages: [{ id: `wamid.e2e-${runId}-${wamidCounter}` }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
  };
  const sender = new MetaWhatsappSender(
    transport,
    new ConfigService({
      meta: {
        accessToken: 'e2e-not-a-token',
        phoneNumberId: 'e2e',
        graphApiBaseUrl: 'https://meta.invalid/e2e',
        sandboxRecipientNormalizationEnabled: false,
      },
    }),
    recorder,
  );

  /* ---- the feed consumer side (real service, window-open stub) ---- */
  const store = new InMemoryHumanRequestFeedStore();
  const ackResults = new Map<string, RecordDeliveryOutcomeResult | string>();
  const delivery = new HumanRequestDeliveryService({
    store,
    client: {
      recordDeliveryOutcome: async (deliveryId, input) => {
        try {
          const result = await client.recordDeliveryOutcome(deliveryId, input);
          ackResults.set(deliveryId, result);
          return result;
        } catch (error) {
          ackResults.set(
            deliveryId,
            error instanceof Error ? error.name : 'error',
          );
          throw error;
        }
      },
      listPendingDeliveries: (filter) => client.listPendingDeliveries(filter),
    },
    sender,
    handoff: { isHumanMode: () => Promise.resolve(false) },
    isWindowOpen: () => Promise.resolve(true),
    customerStyle: () => Promise.resolve(DEFAULT_CUSTOMER_STYLE),
  });
  const seen: Array<{
    deliveryId: string;
    type: string;
    kind: string | null;
    replyId: string | null;
  }> = [];
  const observed = {
    accept: async (item: FeedItem) => {
      if (item.type !== 'unknown' && watched.has(item.requestId)) {
        const payload = item.payload as unknown as Record<string, unknown>;
        seen.push({
          deliveryId: item.deliveryId,
          type: item.type,
          kind: typeof payload.kind === 'string' ? payload.kind : null,
          replyId: typeof payload.replyId === 'string' ? payload.replyId : null,
        });
      }
      await delivery.accept(item);
    },
    abandon: (item: FeedItem, reason: Parameters<typeof delivery.abandon>[1]) =>
      delivery.abandon(item, reason),
    sweepAcks: () => delivery.sweepAcks(),
  } as unknown as HumanRequestDeliveryService;

  line('config', 'ok', {
    phase: 'clarification',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: masked,
    request: requestId,
    minutes: args.minutes,
    sender: 'real MetaWhatsappSender over a stub transport (no Meta call)',
  });

  let start = args.after;
  if (start === null) start = await readTail(client);
  // writeSync: a background log shows the line immediately.
  writeSync(
    1,
    `[consume] listening cursor=${JSON.stringify(start)} request=${JSON.stringify(requestId)}\n`,
  );

  await consume(args, client, store, observed, start, watched, ackResults);

  /* ---- the ACK ---- */
  const sentItem = seen[0];
  const ackRow =
    sentItem === undefined
      ? null
      : await store.getDelivery(sentItem.deliveryId);
  const ack =
    sentItem === undefined ? undefined : ackHttp.get(sentItem.deliveryId);
  line('result', 'item', {
    type: sentItem?.type ?? null,
    kind: sentItem?.kind ?? null,
    replyId: sentItem?.replyId ?? null,
    deliveryId: sentItem?.deliveryId ?? null,
  });
  line('result', 'ack', {
    outcome: ackRow?.ackOutcome ?? null,
    state: ackRow?.ackState ?? null,
    http: ack?.status ?? null,
    code: ack?.code ?? null,
    result:
      sentItem === undefined
        ? null
        : renderAckResult(ackResults.get(sentItem.deliveryId)),
  });
  for (const post of metaPosts)
    line('result', 'sent', {
      to: `…${post.to.slice(-4)}`,
      text: post.text,
      staffReplyIdInMetaPayload: post.staffReplyId,
    });

  /* ---- drain the in-memory outbox through the real mirror stack ---- */
  const problems: string[] = [];
  if (sentItem === undefined) problems.push('no item handled for the request');
  else {
    if (sentItem.kind !== 'CLARIFICATION')
      problems.push(`item kind is ${String(sentItem.kind)}`);
    if (ackRow?.ackOutcome !== 'PROVIDER_ACCEPTED')
      problems.push(`ACK outcome is ${String(ackRow?.ackOutcome ?? null)}`);
    if (ack?.status !== 200) problems.push(`ACK HTTP ${String(ack?.status)}`);
  }

  const gate = new MirrorDeliveryGate();
  // No inbound media in this run: a Meta download would be a script bug.
  const meta: MirrorMetaDownloader = {
    download: () =>
      Promise.resolve({
        kind: 'unsupported' as const,
        reason: 'media_unavailable' as const,
      }),
  };
  const media = new MirrorMediaService({
    client,
    meta,
    links: new LinkMirrorFetcher({ timeoutMs: 20_000 }),
    cache: new InMemoryMirrorMediaCacheStore(),
  });
  const router = new RoutingBackendOutboxDelivery();
  router.register(
    ['MESSAGE_MIRROR'],
    new MirrorMessagesDelivery({ client, media, gate }),
  );
  router.register(
    ['MESSAGE_STATUS'],
    new MirrorStatusesDelivery({ client, outbox, gate }),
  );
  const worker = new BackendOutboxDrainWorker(outboxStore, router, {
    owner: `e2e-${runId}`,
  });
  const enqueued = outboxStore.snapshot();
  line('outbox', 'enqueued', {
    rows: enqueued.length,
    kinds: enqueued.map((row) => row.kind),
  });
  const deadline = Date.now() + DRAIN_BOUND_MS;
  let ticks = 0;
  while (Date.now() < deadline) {
    const open = outboxStore
      .snapshot()
      .some((row) => row.status === 'PENDING' || row.status === 'IN_FLIGHT');
    if (!open) break;
    const claimed = await worker.tick();
    ticks += 1;
    if (claimed === 0) await sleep(500);
  }
  const rows = outboxStore.snapshot();
  line('outbox', 'drained', {
    ticks,
    states: rows.map((row) => ({
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError?.slice(0, 200) ?? null,
    })),
  });

  /* ---- the mirror request ---- */
  for (const call of mirrorCalls)
    line('mirror', 'messages:batch', {
      http: call.status,
      code: call.code,
      messages: call.messages,
    });
  const mirrorOut = mirrorCalls
    .flatMap((call) => call.messages)
    .find((message) => message.direction === 'OUT');
  const mirrored200 = mirrorCalls.some((call) => call.status === 200);
  line('result', 'mirror', {
    outWaMessageId: mirrorOut?.waMessageId ?? null,
    staffReplyIdPresent: mirrorOut?.hasStaffReplyId ?? false,
    mirrorHttp: mirrorCalls.map((call) => call.status),
  });
  if (!mirrored200) problems.push('mirror call is not 200');
  if (mirrorOut?.hasStaffReplyId !== true)
    problems.push('staffReplyId missing in messages:batch');
  if (rows.some((row) => row.status !== 'DONE'))
    problems.push('outbox rows not DONE');
  if (metaPosts.some((post) => post.staffReplyId))
    problems.push('staffReplyId leaked into the Meta payload');

  line('summary', problems.length === 0 ? 'ok' : 'FAILED', {
    conversation: masked,
    problems,
  });
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  line('fatal', 'error', describeError(error));
  process.exitCode = 1;
});
