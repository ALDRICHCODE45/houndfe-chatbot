/** Spec S7 end-to-end run of the human request feed against a DEV backend:
 * create → staff resolve/cancel → feed item → outcome ACK. Drives the REAL
 * ChatbotApiHttpClient, HumanRequestFeedConsumer (`runOnce`, no advisory
 * lock) and HumanRequestDeliveryService over the in-memory feed store. The
 * WhatsApp sender is a fake that only records sends: no real message is ever
 * sent and the chatbot Postgres DB is never touched. WRITES DEV DATA on the
 * backend (a request and the outcome ACKs). Never prints the service key or
 * request headers. See scripts/e2e/README.md. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';
import type {
  CreateHumanRequestInput,
  FeedItem,
  ReadFeedResult,
  RecordDeliveryOutcomeResult,
} from '../../src/chatbot-api/domain/dtos/human-requests.dto';
import { HumanRequestDeliveryService } from '../../src/human-requests/application/human-request-delivery.service';
import { HumanRequestFeedConsumer } from '../../src/human-requests/application/human-request-feed.consumer';
import type { FeedConsumerLock } from '../../src/human-requests/domain/human-request-feed';
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

type Phase = 'create' | 'consume' | 'all';

interface Args {
  phase: Phase;
  phone: string;
  minutes: number;
  after: string | null;
  withRestock: string | null;
  requests: string[];
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: human-requests-feed-e2e [--phase create|consume|all] [--phone 5550001111] [--minutes 15] [--after <cursor>] [--with-restock <productId>] [--request <requestId>]...\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    phase: 'all',
    phone: '5550001111',
    minutes: 15,
    after: null,
    withRestock: null,
    requests: [],
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
        if (value !== 'create' && value !== 'consume' && value !== 'all')
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
      default:
        usage(`unknown argument ${flag}`);
    }
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

main().catch((error: unknown) => {
  line('fatal', 'error', describeError(error));
  process.exitCode = 1;
});
