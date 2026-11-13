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
 * real transcript + mirror stack: see `runClarification`. `--phase
 * live-create` / `--phase live` (unit 11 T9) create a TALK_TO_HUMAN request
 * and consume a whole live conversation (started → staff messages →
 * ended) through the real silence-protocol stack: see `runLiveCreate` /
 * `runLive`. `--phase schedule` / `--phase schedule-feed` (unit 14 T7) drive
 * the real scheduling stack (offer → booking → what time → reschedule →
 * cancel) and the scheduled feed items (reminder / staff reschedule): see
 * `runSchedule` / `runScheduleFeed`. See scripts/e2e/README.md. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { defer, of } from 'rxjs';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';
import type { HumanRequestsClient } from '../../src/chatbot-api/domain/chatbot-api.client';
import type {
  ListSlotsResult,
  RescheduleRequestResult,
  SchedulingSlot,
} from '../../src/chatbot-api/domain/dtos/scheduling.dto';
import { isIsoInstant } from '../../src/chatbot-api/domain/dtos/scheduling.dto';
import type { SchedulingClient } from '../../src/chatbot-api/domain/scheduling.port';
import type {
  CreateHumanRequestInput,
  CreateHumanRequestResult,
  FeedItem,
  HumanRequestCreated,
  OpenHumanRequest,
  ReadFeedResult,
  RecordDeliveryOutcomeResult,
} from '../../src/chatbot-api/domain/dtos/human-requests.dto';
import { HumanRequestDeliveryService } from '../../src/human-requests/application/human-request-delivery.service';
import { HumanRequestFeedConsumer } from '../../src/human-requests/application/human-request-feed.consumer';
import { HumanRequestCreateService } from '../../src/human-requests/application/human-request-create.service';
import { LiveConversationService } from '../../src/human-requests/application/live-conversation.service';
import { ScheduledConversationService } from '../../src/human-requests/application/scheduled-conversation.service';
import { isScheduledConversationItem } from '../../src/chatbot-api/domain/dtos/human-requests.dto';
import { AppointmentIntentService } from '../../src/scheduling/application/appointment-intent.service';
import { SchedulingOutOfHoursPolicy } from '../../src/scheduling/application/scheduling-out-of-hours.policy';
import { SchedulingStateService } from '../../src/scheduling/application/scheduling-state.service';
import { StoredAppointmentReader } from '../../src/scheduling/application/stored-appointment.reader';
import {
  alreadyBookedText,
  bookedOutOfWindowText,
  bookedText,
  cancelledText,
  noSlotsText,
  offerText,
  rescheduledText,
  rescheduleOfferText,
  reminderText,
  slotTakenText,
  staffChangedText,
  whatTimeText,
} from '../../src/scheduling/domain/scheduling-copy';
import {
  formatClock,
  formatWhen,
  slotLabel,
} from '../../src/scheduling/domain/slot-time';
import type { SchedulingOffer } from '../../src/conversation/domain/scheduling-state';
import {
  LIVE_FAREWELL,
  maskConversationRef,
  styleFixedCopy,
  type FeedConsumerLock,
} from '../../src/human-requests/domain/human-request-feed';
import type { LiveConversationClient } from '../../src/chatbot-api/domain/live-conversation.port';
import { HandoffModeService } from '../../src/conversation/application/handoff-mode.service';
import { InMemoryConversationStore } from '../../src/conversation/infrastructure/in-memory-conversation.store';
import type { OutboundTranscriptRecorder } from '../../src/conversation-transcript/application/transcript-recorder';
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
import {
  applyCustomerStyle,
  DEFAULT_CUSTOMER_STYLE,
  type CustomerStyle,
} from '../../src/llm-agent/domain/customer-style';
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

type Phase =
  | 'create'
  | 'consume'
  | 'all'
  | 'recovery'
  | 'clarification'
  | 'live'
  | 'live-create'
  | 'schedule'
  | 'schedule-feed';

interface Args {
  phase: Phase;
  phone: string;
  minutes: number;
  minutesGiven: boolean;
  after: string | null;
  withRestock: string | null;
  requests: string[];
  updatedSince: string | null;
  /** `--phase live` / `schedule-feed`: the window stub answers "closed". */
  windowClosed: boolean;
  /** `--phase schedule`: also cancel the appointment at the end. */
  cancel: boolean;
  /** `--phase schedule`: lose the first reschedule answer (retry drill). */
  drill: boolean;
  /** `--phase schedule-feed`: the appointment the bot is seeded with. */
  scheduledFor: string | null;
  version: number | null;
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: human-requests-feed-e2e [--phase create|consume|all|recovery|clarification|live|live-create|schedule|schedule-feed] [--phone 5550001111] [--minutes 15] [--after <cursor>] [--with-restock <productId>] [--request <requestId>]... [--updated-since <ISO ms Z>] [--window-closed] [--cancel] [--no-drill] [--scheduled-for <ISO>] [--version <n>]\n`,
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
    windowClosed: false,
    cancel: false,
    drill: true,
    scheduledFor: null,
    version: null,
  };
  const rest = argv.filter((arg) => arg !== '--');
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--window-closed') {
      args.windowClosed = true;
      continue;
    }
    if (flag === '--cancel') {
      args.cancel = true;
      continue;
    }
    if (flag === '--no-drill') {
      args.drill = false;
      continue;
    }
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
          value !== 'clarification' &&
          value !== 'live' &&
          value !== 'live-create' &&
          value !== 'schedule' &&
          value !== 'schedule-feed'
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
      case '--scheduled-for':
        if (!isIsoInstant(value))
          usage('--scheduled-for must be an ISO instant');
        args.scheduledFor = value;
        break;
      case '--version':
        args.version = Number(value);
        if (!Number.isSafeInteger(args.version) || args.version < 1)
          usage('--version must be an integer >= 1');
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
  if (args.phase === 'live') {
    if (args.requests.length !== 1)
      usage('--phase live needs exactly one --request <id>');
    if (!args.minutesGiven) args.minutes = 10;
  }
  if (args.phase === 'schedule-feed') {
    if (args.requests.length !== 1)
      usage('--phase schedule-feed needs exactly one --request <id>');
    if (args.after === null) usage('--phase schedule-feed needs --after');
    if (args.scheduledFor === null)
      usage('--phase schedule-feed needs --scheduled-for <ISO>');
    if (args.version === null)
      usage('--phase schedule-feed needs --version <n>');
    if (!args.minutesGiven) args.minutes = 10;
  }
  if (
    args.windowClosed &&
    args.phase !== 'live' &&
    args.phase !== 'schedule-feed'
  )
    usage('--window-closed is only for --phase live and schedule-feed');
  if (args.cancel && args.phase !== 'schedule')
    usage('--cancel is only for --phase schedule');
  if (!args.drill && args.phase !== 'schedule')
    usage('--no-drill is only for --phase schedule');
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
  if (args.phase === 'live-create') {
    await runLiveCreate(args, serviceKey);
    return;
  }
  if (args.phase === 'live') {
    await runLive(args, serviceKey);
    return;
  }
  if (args.phase === 'schedule') {
    await runSchedule(args, serviceKey);
    return;
  }
  if (args.phase === 'schedule-feed') {
    await runScheduleFeed(args, serviceKey);
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
  /** `--phase live` only: another stop condition and a filter for the items
   *  of other conversations (never handled, never ACKed). */
  liveMode?: { done: () => boolean; skip: (item: FeedItem) => boolean },
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
        if (liveMode?.skip(item) === true) return;
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
  const done =
    liveMode?.done ??
    (() =>
      watched.size > 0 && [...watched].every((id) => handledRequests.has(id)));
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

/* ======================================================================
 * --phase live-create / --phase live (unit 11 T9): the silence protocol
 * ====================================================================== */

const SESSION_ACK_URL = /\/chatbot-api\/conversations\/[^/]+\/session-ack$/;
const MEDIA_DOWNLOAD_URL = /\/chatbot-api\/media\/([^/?]+)$/;

/** `--phase live-create`: a TALK_TO_HUMAN request through the REAL create
 *  path (`HumanRequestCreateService.requestTalkToHuman` → the real client),
 *  then the feed tail, so the parent can claim it and `--phase live` can
 *  start right after that cursor. WRITES a request on the dev backend. */
async function runLiveCreate(args: Args, serviceKey: string): Promise<void> {
  const conversationRef = `wa:521${args.phone}`;
  const client = new ChatbotApiHttpClient(
    new HttpService(axios.create()),
    new ConfigService({
      chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
    }),
  );
  line('config', 'ok', {
    phase: 'live-create',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    conversation: maskConversationRef(conversationRef),
  });

  // The create answer carries the folio, which the outcome type does not.
  const captured: { response: HumanRequestCreated | null } = { response: null };
  const sends: string[] = [];
  const create = new HumanRequestCreateService({
    client: {
      createHumanRequest: async (input) => {
        const result = await client.createHumanRequest(input);
        if (result.kind === 'ok') captured.response = result.response;
        return result;
      },
      cancelHumanRequest: (...rest) => client.cancelHumanRequest(...rest),
    },
    store: new InMemoryHumanRequestFeedStore(),
    outbox: new BackendOutboxService(new InMemoryBackendOutboxStore()),
    sender: {
      sendText: (message: OutboundText) => {
        sends.push(message.text);
        return Promise.resolve({
          providerMessageId: `wamid.e2e-live-create-${sends.length}`,
        });
      },
    },
    handoff: { isHumanMode: () => Promise.resolve(false) },
    isWindowOpen: () => Promise.resolve(true),
  });

  const outcome = await create.requestTalkToHuman({
    senderId: `521${args.phone}`,
    text: 'E2E unit 11: quiero hablar con una persona',
  });
  const response = captured.response;
  if (outcome.kind !== 'registered' || response === null) {
    line('live-create', 'FAILED', { outcome });
    process.exitCode = 1;
    return;
  }
  const cursor = await readTail(client);
  line('live-create', 'ok', {
    requestId: outcome.requestId,
    folio: response.folio,
    outcome: response.outcome,
    merged: outcome.merged,
    mergedIntoId: response.mergedIntoId,
    requestStatus: response.status,
    cursor,
    customerNotifiedByThisRun: sends.length,
  });
}

type LiveOrigin = 'BOT' | 'STAFF' | 'TEMPLATE';

/** The feed item being handled when an event happens. */
interface LiveContext {
  type: string;
  epoch: number | null;
  deliveryId: string;
}

interface LiveEventBase {
  seq: number;
  during: LiveContext | null;
}
interface LiveAckEvent extends LiveEventBase {
  kind: 'ack';
  epoch: number | null;
  state: string | null;
  providerMessageId: string | null;
  http: number | null;
}
interface LiveOutcomeEvent extends LiveEventBase {
  kind: 'outcome';
  deliveryId: string;
  outcome: string | null;
  http: number | null;
}
interface LiveSendEvent extends LiveEventBase {
  kind: 'send';
  wamid: string;
  wireType: string;
  text: string | null;
  modeAtSend: string | null;
  epochAtSend: number | null;
  /** Set by the transcript recorder wrapper; null = never recorded. */
  origin: LiveOrigin | null;
  /** Whether the transcript row is enqueued for the mirror. */
  mirror: boolean | null;
}
type LiveEvent = LiveAckEvent | LiveOutcomeEvent | LiveSendEvent;

interface LiveMirrorMessage {
  waMessageId: string;
  direction: string;
  /** The wire `author`, or the backend default (OUT → BOT). */
  author: string;
  authorSent: boolean;
  type: string;
  hasStaffReplyId: boolean;
  text: string | null;
}
interface LiveMirrorCall {
  status: number | null;
  code: string | null;
  hint: { mode: unknown; handoffEpoch: unknown } | null;
  messages: LiveMirrorMessage[];
}

interface MetaStubPayload {
  to: string;
  type: string;
  text?: { body?: string };
  image?: { caption?: string };
  document?: { filename?: string; caption?: string };
  template?: { name?: string; language?: { code?: string } };
}

function jsonObject(data: unknown): Record<string, unknown> {
  let body: unknown = data;
  if (typeof data === 'string') {
    try {
      body = JSON.parse(data);
    } catch {
      return {};
    }
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) if (key in source) picked[key] = source[key];
  return picked;
}

function itemEpoch(item: FeedItem): number | null {
  switch (item.type) {
    case 'conversation.started':
    case 'conversation.staff_message':
    case 'template.requested':
    case 'conversation.reassigned':
    case 'conversation.ended':
      return item.payload.handoffEpoch;
    default:
      return null;
  }
}

/** What distinguishes the items of a live conversation in the log. */
function liveDetail(item: FeedItem): Record<string, unknown> {
  switch (item.type) {
    case 'conversation.started':
    case 'conversation.reassigned':
      return { staffFirstName: item.payload.staffFirstName };
    case 'conversation.staff_message':
      return { seq: item.payload.seq, messageType: item.payload.type };
    case 'template.requested':
      return {
        seq: item.payload.seq,
        templateName: item.payload.templateName,
        languageCode: item.payload.languageCode,
      };
    case 'conversation.ended':
      return {
        reason: item.payload.reason,
        farewell: item.payload.farewell,
        resumeNotice: item.payload.resumeNotice,
      };
    default:
      return {};
  }
}

async function drainBody(body: unknown): Promise<number> {
  if (
    typeof body !== 'object' ||
    body === null ||
    !(Symbol.asyncIterator in body)
  )
    return 0;
  let bytes = 0;
  for await (const chunk of body as AsyncIterable<Buffer | string>)
    bytes += chunk.length;
  return bytes;
}

/**
 * `--phase live` (unit 11 T9, S2–S5, S8): consumes a whole live conversation
 * of ONE request through the REAL production pieces: `HumanRequestFeedConsumer`
 * (`runOnce`), `HumanRequestDeliveryService`, `LiveConversationService` with
 * `HandoffModeService` over an in-memory conversation store, the real
 * `ChatbotApiHttpClient` (feed, session-ack, staff media download, outcome
 * ACKs, `messages:batch`), the real `MetaWhatsappSender` over a stub transport
 * (fake wamids and fake Meta media ids: Meta is never called), the real
 * `TranscriptRecorder` and an in-memory outbox that is drained at the end
 * through the real mirror delivery.
 *
 * Items of OTHER conversations are skipped (never handled or ACKed): a live
 * item would otherwise session-ack somebody else's session on dev.
 */
async function runLive(args: Args, serviceKey: string): Promise<void> {
  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const [requestId] = args.requests;
  const watched = new Set([requestId]);
  const senderId = `521${args.phone}`;
  const conversationRef = `wa:${senderId}`;
  const masked = maskConversationRef(conversationRef);

  /* ---- the ordered event log (every HTTP call and every Meta send) ---- */
  const events: LiveEvent[] = [];
  const mirrorCalls: LiveMirrorCall[] = [];
  let seq = 0;
  let during: LiveContext | null = null;
  let lastDownload: {
    mimeType: string;
    filename: string;
    sizeBytes: number;
    sha256: string;
  } | null = null;

  const observeHttp = (
    config: { url?: string; data?: unknown },
    status: number | null,
    data: unknown,
  ) => {
    const url = config.url ?? '';
    if (SESSION_ACK_URL.test(url)) {
      const request = jsonObject(config.data);
      const answer = jsonObject(data);
      const event: LiveAckEvent = {
        kind: 'ack',
        seq: (seq += 1),
        during,
        epoch: typeof request.epoch === 'number' ? request.epoch : null,
        state: typeof request.state === 'string' ? request.state : null,
        providerMessageId:
          typeof request.providerMessageId === 'string'
            ? request.providerMessageId
            : null,
        http: status,
      };
      events.push(event);
      line('live', 'session-ack', {
        state: event.state,
        epoch: event.epoch,
        providerMessageId: event.providerMessageId,
        http: status,
        answer: pick(answer, [
          'epoch',
          'state',
          'sessionState',
          'code',
          'errorCode',
          'currentEpoch',
          'mode',
        ]),
        during: during?.type ?? null,
      });
    } else if (OUTCOME_URL.test(url)) {
      const match = OUTCOME_URL.exec(url);
      const request = jsonObject(config.data);
      const event: LiveOutcomeEvent = {
        kind: 'outcome',
        seq: (seq += 1),
        during,
        deliveryId: match === null ? '' : decodeURIComponent(match[1]),
        outcome: typeof request.outcome === 'string' ? request.outcome : null,
        http: status,
      };
      events.push(event);
      line('live', 'outcome-ack', {
        deliveryId: event.deliveryId,
        outcome: event.outcome,
        http: status,
        code: bodyCode(data),
        during: during?.type ?? null,
      });
    } else if (MEDIA_DOWNLOAD_URL.test(url)) {
      line('live', 'staff media GET', { http: status, during: during?.type });
    } else if (MESSAGES_ROUTE.test(url)) {
      const answer = jsonObject(data);
      mirrorCalls.push({
        status,
        code: bodyCode(data),
        hint:
          'mode' in answer || 'handoffEpoch' in answer
            ? { mode: answer.mode, handoffEpoch: answer.handoffEpoch }
            : null,
        messages: summarizeLiveMirrorBody(config.data),
      });
    }
  };
  const http = axios.create();
  http.interceptors.response.use(
    (response: AxiosResponse) => {
      recordAckHttp(response.config.url, {
        status: response.status,
        code: null,
      });
      observeHttp(response.config, response.status, response.data);
      return response;
    },
    (error: AxiosError) => {
      recordAckHttp(error.config?.url, {
        status: error.response?.status ?? null,
        code: bodyCode(error.response?.data),
      });
      observeHttp(
        error.config ?? {},
        error.response?.status ?? null,
        error.response?.data,
      );
      return Promise.reject(error);
    },
  );
  const client = new ChatbotApiHttpClient(
    new HttpService(http),
    new ConfigService({
      chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
    }),
  );

  /* ---- local state: in-memory conversation store behind the real
   *      HandoffModeService, in-memory feed ledger ---- */
  const handoff = new HandoffModeService(new InMemoryConversationStore());
  const feedStore = new InMemoryHumanRequestFeedStore();
  const modeNow = async () => {
    try {
      const state = await handoff.getState(senderId);
      return { mode: state.mode as string, epoch: state.epoch };
    } catch {
      return { mode: null, epoch: null };
    }
  };

  /* ---- transcript → in-memory outbox (production recorder), wrapped only
   *      to learn each send's origin and whether it is enqueued ---- */
  const outboxStore = new InMemoryBackendOutboxStore();
  const outbox = new BackendOutboxService(outboxStore);
  const realRecorder = new TranscriptRecorder(
    new InMemoryTranscriptStore(),
    undefined,
    outbox,
  );
  const recorder: OutboundTranscriptRecorder = {
    recordOutbound: async (entry) => {
      const send = events.find(
        (event): event is LiveSendEvent =>
          event.kind === 'send' && event.wamid === entry.providerMessageId,
      );
      const details = entry.details ?? {};
      const origin: LiveOrigin =
        entry.author === 'STAFF'
          ? 'STAFF'
          : details.origin === 'TEMPLATE'
            ? 'TEMPLATE'
            : 'BOT';
      const mirror = entry.mirror !== false;
      if (send !== undefined) {
        send.origin = origin;
        send.mirror = mirror;
        const media = entry.media ?? null;
        line('live', 'would send', {
          to: `…${senderId.slice(-4)}`,
          wamid: send.wamid,
          origin,
          wouldMirror: mirror,
          wireType: send.wireType,
          text: send.text,
          ...(media === null
            ? {}
            : {
                mimeType: media.mimeType ?? null,
                sentAs: send.wireType === 'document' ? 'document' : 'image',
                downloadedSha256: lastDownload?.sha256 ?? null,
              }),
          modeAtSend: send.modeAtSend,
          epochAtSend: send.epochAtSend,
          during: send.during?.type ?? null,
        });
      }
      await realRecorder.recordOutbound(entry);
    },
  };

  /* ---- the real Meta sender over a stub transport ---- */
  let wamidCounter = 0;
  let mediaCounter = 0;
  const transport = new HttpService();
  (transport as { post: unknown }).post = (url: string, payload: unknown) =>
    defer(async () => {
      const reply = (data: unknown) => ({
        data,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      });
      if (url.endsWith('/media')) {
        mediaCounter += 1;
        const mediaId = `e2e-media-${runId}-${mediaCounter}`;
        const bytes = await drainBody(payload);
        line('live', 'meta upload (stub)', {
          mediaId,
          multipartBytes: bytes,
          during: during?.type ?? null,
        });
        return reply({ id: mediaId });
      }
      const body = payload as MetaStubPayload;
      wamidCounter += 1;
      const wamid = `wamid.e2e-${runId}-${wamidCounter}`;
      const state = await modeNow();
      const text =
        body.text?.body ??
        body.image?.caption ??
        body.document?.caption ??
        body.document?.filename ??
        (body.template === undefined
          ? null
          : `template ${body.template.name ?? ''} ${body.template.language?.code ?? ''}`.trim()) ??
        null;
      events.push({
        kind: 'send',
        seq: (seq += 1),
        during,
        wamid,
        wireType: body.type,
        text: text ?? null,
        modeAtSend: state.mode,
        epochAtSend: state.epoch,
        origin: null,
        mirror: null,
      });
      return reply({ messages: [{ id: wamid }] });
    });
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

  /* ---- the real client behind LIVE_CONVERSATION_CLIENT, observed ---- */
  const live: LiveConversationClient = {
    sessionAck: (ref, input) => client.sessionAck(ref, input),
    getConversationState: (ref) => client.getConversationState(ref),
    listHumanConversations: (options) => client.listHumanConversations(options),
    downloadStaffMedia: async (mediaId, options) => {
      const result = await client.downloadStaffMedia(mediaId, options);
      if (result.kind === 'ok') {
        lastDownload = {
          mimeType: result.mimeType,
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
        };
        line('live', 'staff media downloaded', {
          mediaId,
          mimeType: result.mimeType,
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
        });
      } else line('live', 'staff media download failed', { kind: result.kind });
      return result;
    },
  };

  /* ---- the production service graph (window stub, usted style) ---- */
  const isWindowOpen = () => Promise.resolve(!args.windowClosed);
  const customerStyle = () => Promise.resolve(DEFAULT_CUSTOMER_STYLE);
  const ackResults = new Map<string, RecordDeliveryOutcomeResult | string>();
  const delivery = new HumanRequestDeliveryService({
    store: feedStore,
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
    handoff: { isHumanMode: (id: string) => handoff.isHumanMode(id) },
    isWindowOpen,
    customerStyle,
    live: new LiveConversationService({
      mode: handoff,
      client: live,
      sender,
      isWindowOpen,
      customerStyle,
    }),
  });

  /* ---- observation around each handled item ---- */
  const handled: Array<{
    deliveryId: string;
    type: string;
    epoch: number | null;
    decision: string | null;
  }> = [];
  let endedHandled = false;
  let skipped = 0;
  const isWatched = (item: FeedItem): boolean =>
    item.type !== 'unknown' &&
    (item.conversationRef === conversationRef ||
      (item.conversationRef === null && watched.has(item.requestId)));
  const observed = {
    accept: async (item: FeedItem) => {
      const type =
        item.type === 'unknown' ? `unknown:${item.rawType}` : item.type;
      during = { type, epoch: itemEpoch(item), deliveryId: item.deliveryId };
      lastDownload = null;
      try {
        await delivery.accept(item);
        const row = await feedStore.getDelivery(item.deliveryId);
        const after = await modeNow();
        const ack = ackHttp.get(item.deliveryId);
        line('live', 'item', {
          cursor: item.cursor,
          type,
          epoch: during.epoch,
          ...liveDetail(item),
          requestId: item.type === 'unknown' ? null : item.requestId,
          deliveryId: item.deliveryId,
          decision: row?.decision ?? null,
          localState: row?.localState ?? null,
          ackOutcome: row?.ackOutcome ?? null,
          ackState: row?.ackState ?? null,
          ackHttp: ack?.status ?? null,
          ackCode: ack?.code ?? null,
          ackResult: renderAckResult(ackResults.get(item.deliveryId)),
          modeAfter: after.mode,
          epochAfter: after.epoch,
        });
        handled.push({
          deliveryId: item.deliveryId,
          type,
          epoch: during.epoch,
          decision: row?.decision ?? null,
        });
        if (item.type === 'conversation.ended' && watched.has(item.requestId))
          endedHandled = true;
      } finally {
        during = null;
      }
    },
    abandon: (item: FeedItem, reason: Parameters<typeof delivery.abandon>[1]) =>
      delivery.abandon(item, reason),
    sweepAcks: () => delivery.sweepAcks(),
    // SAFETY: `consume` only calls accept / abandon / sweepAcks on the delivery
    // service; the object above implements exactly those three.
  } as unknown as HumanRequestDeliveryService;

  line('config', 'ok', {
    phase: 'live',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: masked,
    request: requestId,
    minutes: args.minutes,
    windowStub: args.windowClosed ? 'closed' : 'open',
    sender: 'real MetaWhatsappSender over a stub transport (no Meta call)',
  });

  let start = args.after;
  if (start === null) start = await readTail(client);
  // writeSync: a background log shows the line immediately.
  writeSync(
    1,
    `[consume] listening cursor=${JSON.stringify(start)} request=${JSON.stringify(requestId)}\n`,
  );

  await consume(args, client, feedStore, observed, start, watched, ackResults, {
    done: () => endedHandled,
    skip: (item) => {
      if (isWatched(item)) return false;
      skipped += 1;
      if (skipped <= 20)
        line('live', 'skipped item of another conversation', {
          cursor: item.cursor,
          type: item.type === 'unknown' ? `unknown:${item.rawType}` : item.type,
          conversation:
            item.type === 'unknown' || item.conversationRef === null
              ? null
              : maskConversationRef(item.conversationRef),
        });
      return true;
    },
  });
  if (skipped > 0) line('live', 'skipped items', { count: skipped });

  /* ---- drain the in-memory outbox through the real mirror stack ---- */
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
  const drainDeadline = Date.now() + DRAIN_BOUND_MS;
  let ticks = 0;
  while (Date.now() < drainDeadline) {
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
  for (const call of mirrorCalls)
    line('mirror', 'messages:batch', {
      http: call.status,
      code: call.code,
      hint: call.hint,
      messages: call.messages.map((message) => ({
        waMessageId: message.waMessageId,
        direction: message.direction,
        author: message.author,
        authorSent: message.authorSent,
        type: message.type,
        staffReplyIdPresent: message.hasStaffReplyId,
        text: message.author === 'BOT' ? message.text : null,
      })),
    });

  /* ---- the assertions ---- */
  const problems: string[] = [];
  const sends = events.filter((e): e is LiveSendEvent => e.kind === 'send');
  const acks = events.filter((e): e is LiveAckEvent => e.kind === 'ack');

  if (!endedHandled)
    problems.push('no conversation.ended handled for the request (time bound)');
  for (const send of sends)
    if (send.origin === null)
      problems.push(`send ${send.wamid} was never recorded in the transcript`);

  // 1. The greeting follows a 200 session-ack STARTED of its epoch.
  for (const send of sends) {
    if (send.origin !== 'BOT' || send.during?.type !== 'conversation.started')
      continue;
    const epoch = send.during.epoch;
    const prior = acks.filter(
      (ack) =>
        ack.state === 'STARTED' && ack.epoch === epoch && ack.seq < send.seq,
    );
    const last = prior[prior.length - 1];
    if (last === undefined)
      problems.push(
        `greeting of epoch ${String(epoch)} sent without a prior session-ack STARTED`,
      );
    else if (last.http !== 200)
      problems.push(
        `greeting of epoch ${String(epoch)} sent after a non-200 session-ack STARTED (${String(last.http)})`,
      );
  }

  // 2. Staff messages and templates are never mirrored; every BOT message is.
  const relayed = sends.filter(
    (send) => send.origin === 'STAFF' || send.origin === 'TEMPLATE',
  );
  const relayedWamids = new Set(relayed.map((send) => send.wamid));
  const relayedTexts = new Set(
    relayed.flatMap((send) => (send.text ? [send.text] : [])),
  );
  for (const send of relayed)
    if (send.mirror !== false)
      problems.push(
        `${String(send.origin)} message ${send.wamid} was enqueued for the mirror`,
      );
  const mirroredBot = new Set<string>();
  for (const call of mirrorCalls)
    for (const message of call.messages) {
      if (relayedWamids.has(message.waMessageId))
        problems.push(
          `staff/template message ${message.waMessageId} was mirrored (messages:batch)`,
        );
      if (message.text !== null && relayedTexts.has(message.text))
        problems.push(
          `a mirrored message carries staff text (${message.waMessageId})`,
        );
      if (message.hasStaffReplyId)
        problems.push(
          `a mirrored message carries a staffReplyId (${message.waMessageId})`,
        );
      if (
        call.status === 200 &&
        message.direction === 'OUT' &&
        message.author === 'BOT'
      )
        mirroredBot.add(message.waMessageId);
    }
  for (const send of sends)
    if (send.origin === 'BOT' && !mirroredBot.has(send.wamid))
      problems.push(
        `BOT message ${send.wamid} (${send.during?.type ?? 'no item'}) was not mirrored as BOT`,
      );
  if (rows.some((row) => row.status !== 'DONE'))
    problems.push('outbox rows not DONE');

  // 3. A staff message / template is only sent while HUMAN on its epoch.
  for (const send of relayed) {
    if (send.modeAtSend !== 'HUMAN')
      problems.push(
        `${String(send.origin)} message ${send.wamid} sent while the mode was ${String(send.modeAtSend)}`,
      );
    const item = send.during;
    if (
      item !== null &&
      (item.type === 'conversation.staff_message' ||
        item.type === 'template.requested') &&
      item.epoch !== send.epochAtSend
    )
      problems.push(
        `${String(send.origin)} message ${send.wamid} of epoch ${String(item.epoch)} sent on epoch ${String(send.epochAtSend)}`,
      );
  }

  // 4. The farewell comes before anything replayed (a send or an ACK of
  //    another delivery) and before the session-ack ENDED.
  const farewellText = styleFixedCopy(LIVE_FAREWELL, DEFAULT_CUSTOMER_STYLE);
  for (const item of handled) {
    if (item.type !== 'conversation.ended' || item.decision !== 'FAREWELL')
      continue;
    const inItem = events.filter(
      (event) => event.during?.deliveryId === item.deliveryId,
    );
    const first = inItem.find((e): e is LiveSendEvent => e.kind === 'send');
    if (
      first === undefined ||
      first.origin !== 'BOT' ||
      first.text !== farewellText
    ) {
      problems.push(
        `the farewell of ${item.deliveryId} was not the first send of its item`,
      );
      continue;
    }
    const early = inItem.find(
      (event) =>
        event.seq < first.seq &&
        ((event.kind === 'outcome' && event.deliveryId !== item.deliveryId) ||
          (event.kind === 'ack' && event.state === 'ENDED')),
    );
    if (early !== undefined)
      problems.push(
        `a replayed ${early.kind} came before the farewell of ${item.deliveryId}`,
      );
  }

  line('summary', problems.length === 0 ? 'ok' : 'FAILED', {
    conversation: masked,
    items: handled.length,
    sends: sends.map((send) => ({
      wamid: send.wamid,
      origin: send.origin,
      wouldMirror: send.mirror,
      during: send.during?.type ?? null,
    })),
    sessionAcks: acks.map((ack) => ({
      state: ack.state,
      epoch: ack.epoch,
      http: ack.http,
    })),
    problems,
  });
  if (problems.length > 0) process.exitCode = 1;
}

/** The serialized messages:batch body for the live report: keeps the text
 *  (for the staff-text assertion) but never headers or the conversation ref. */
function summarizeLiveMirrorBody(data: unknown): LiveMirrorMessage[] {
  const body = jsonObject(data);
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  return messages.map((raw: unknown) => {
    const m = jsonObject(raw);
    const direction = text(m.direction);
    const author = text(m.author);
    return {
      waMessageId: text(m.waMessageId),
      direction,
      author: author !== '' ? author : direction === 'OUT' ? 'BOT' : 'CUSTOMER',
      authorSent: author !== '',
      type: text(m.type),
      hasStaffReplyId: text(m.staffReplyId) !== '',
      text: typeof m.text === 'string' ? m.text : null,
    };
  });
}

/* ======================================================================
 * --phase schedule / --phase schedule-feed (unit 14 T7, S2, S3, S6)
 * ====================================================================== */

/** Just the parts of an axios config the scheduling report reads. */
interface WireConfig {
  method?: string;
  url?: string;
  params?: unknown;
  data?: unknown;
  headers?: unknown;
}

const TU_STYLE: CustomerStyle = {
  register: 'tu',
  emojis: false,
  tone: 'neutral',
};

const SLOTS_PATH = '/chatbot-api/scheduling/slots';
const REQUESTS_PATH = '/chatbot-api/requests';
const RESCHEDULE_PATH = /^\/chatbot-api\/requests\/([^/]+)\/reschedule$/;
const CANCEL_PATH = /^\/chatbot-api\/requests\/([^/]+)\/cancel$/;
const STATE_PATH = /^\/chatbot-api\/conversations\/[^/]+\/state$/;
/** The report's last-resort zone (the contract's items carry their own). */
const DEFAULT_ZONE_FOR_REPORT = 'America/Mexico_City';

/** The only header ever read: never the Authorization one. */
function idempotencyKeyOf(headers: unknown): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const bag = headers as Record<string, unknown>;
  const value =
    typeof bag.get === 'function'
      ? (headers as { get: (name: string) => unknown }).get('X-Idempotency-Key')
      : bag['X-Idempotency-Key'];
  return typeof value === 'string' ? value : null;
}

const shortKey = (key: string | null): string | null =>
  key === null ? null : `${key.slice(0, 8)}…`;

function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
}

/** The route as the report prints it: the conversation ref is masked. */
function reportRoute(url: string): string {
  const path = pathOf(url);
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // keep the encoded path
  }
  return decoded.replace(/wa:[0-9]+/g, (ref) => maskConversationRef(ref));
}

interface ScheduleWireCall {
  seq: number;
  method: string;
  path: string;
  status: number | null;
  key: string | null;
  body: Record<string, unknown>;
}

/**
 * One axios instance whose interceptors (a) keep the outcome-ACK status for
 * the feed report, (b) hand every call to `observe`. Request headers other
 * than the idempotency key are never read.
 */
function observedClient(
  serviceKey: string,
  observe: (config: WireConfig, status: number | null, data: unknown) => void,
): ChatbotApiHttpClient {
  const http = axios.create();
  http.interceptors.response.use(
    (response: AxiosResponse) => {
      recordAckHttp(response.config.url, {
        status: response.status,
        code: null,
      });
      observe(response.config, response.status, response.data);
      return response;
    },
    (error: AxiosError) => {
      recordAckHttp(error.config?.url, {
        status: error.response?.status ?? null,
        code: bodyCode(error.response?.data),
      });
      observe(
        error.config ?? {},
        error.response?.status ?? null,
        error.response?.data,
      );
      return Promise.reject(error);
    },
  );
  return new ChatbotApiHttpClient(
    new HttpService(http),
    new ConfigService({
      chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
    }),
  );
}

/** The text as the dispatcher sends it for a customer of that style. */
const asSent = (usted: string, style: CustomerStyle): string =>
  applyCustomerStyle(usted, style);

/** Builds the offer exactly as `planAsk` would (used only when the branch is
 *  open and the closed-hours offer cannot be exercised). */
function offerFromSlots(
  answer: Extract<ListSlotsResult, { kind: 'ok' }>,
  now: Date,
  sourceRequestId: string,
): SchedulingOffer {
  return {
    slots: answer.slots.slice(0, 3).map((slot: SchedulingSlot) => ({
      startsAt: slot.startsAt,
      withinWindow: slot.withinWindow,
    })),
    timeZone: answer.timeZone,
    offeredAt: now.toISOString(),
    subtype: 'TALK_TO_HUMAN',
    sourceRequestId,
    openWhen: formatWhen(
      answer.businessHours.nextOpenAt ?? answer.slots[0].startsAt,
      answer.timeZone,
      now,
    ),
    unclearCount: 0,
  };
}

/**
 * `--phase schedule` (unit 14 T7): drives the REAL scheduling stack with
 * simulated customer texts against the dev backend, over an in-memory
 * conversation store: `SchedulingOutOfHoursPolicy` (planAsk / handleReply),
 * `AppointmentIntentService`, `SchedulingStateService`, the real
 * `ChatbotApiHttpClient` (also behind SCHEDULING_CLIENT) and the real
 * customer styling. No WhatsApp message is sent (the replies are printed).
 * WRITES DEV DATA: a real scheduled TALK_TO_HUMAN request.
 *
 * Fails (exit 1) on: a booking that was not inline (no 2xx scheduled answer,
 * the outbox used, or the unscheduled create called), a scheduling call
 * without `lastCustomerMessageAt`, a reply that is not an approved builder's
 * output, or a reschedule retry that did not reuse its idempotency key.
 */
async function runSchedule(args: Args, serviceKey: string): Promise<void> {
  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const senderId = `521${args.phone}`;
  const conversationRef = `wa:${senderId}`;
  const problems: string[] = [];
  const problem = (message: string) => {
    problems.push(message);
    line('problem', 'FOUND', { message });
  };

  /* ---- every backend call, in order ---- */
  const wire: ScheduleWireCall[] = [];
  let wireSeq = 0;
  const observe = (
    config: WireConfig,
    status: number | null,
    data: unknown,
  ) => {
    const method = (config.method ?? 'get').toUpperCase();
    const path = pathOf(config.url ?? '');
    const body = jsonObject(config.data);
    const answer = jsonObject(data);
    const key = idempotencyKeyOf(config.headers);
    wire.push({ seq: (wireSeq += 1), method, path, status, key, body });
    let detail: Record<string, unknown>;
    if (path === SLOTS_PATH) {
      const params = jsonObject(config.params);
      if (!isIsoInstant(params.lastCustomerMessageAt))
        problem('GET scheduling/slots went out without lastCustomerMessageAt');
      const hours = jsonObject(answer.businessHours);
      detail = {
        lastCustomerMessageAt: params.lastCustomerMessageAt ?? null,
        openNow: hours.openNow ?? null,
        nextOpenAt: hours.nextOpenAt ?? null,
        timeZone: answer.timeZone ?? hours.timeZone ?? null,
        whatsappWindowClosesAt: answer.whatsappWindowClosesAt ?? null,
        slots: answer.slots ?? null,
        code: bodyCode(data),
      };
    } else if (path === REQUESTS_PATH && method === 'POST') {
      if (
        body.scheduledFor !== undefined &&
        !isIsoInstant(body.lastCustomerMessageAt)
      )
        problem(
          'POST requests (scheduled) went out without lastCustomerMessageAt',
        );
      detail = {
        subtype: body.subtype ?? null,
        scheduledFor: body.scheduledFor ?? null,
        lastCustomerMessageAt: body.lastCustomerMessageAt ?? null,
        key: shortKey(key),
        answer: pick(answer, [
          'id',
          'folio',
          'status',
          'outcome',
          'mergedIntoId',
          'scheduledFor',
          'scheduleVersion',
          'requiresTemplateAtStart',
          'whatsappWindowClosesAt',
          'requestId',
          'timeZone',
        ]),
        slotsInAnswer: Array.isArray(answer.slots) ? answer.slots : undefined,
        code: bodyCode(data),
      };
    } else if (RESCHEDULE_PATH.test(path)) {
      if (!isIsoInstant(body.lastCustomerMessageAt))
        problem('POST reschedule went out without lastCustomerMessageAt');
      detail = {
        scheduledFor: body.scheduledFor ?? null,
        lastCustomerMessageAt: body.lastCustomerMessageAt ?? null,
        key: shortKey(key),
        answer: pick(answer, [
          'id',
          'outcome',
          'scheduledFor',
          'previousScheduledFor',
          'scheduleVersion',
          'requiresTemplateAtStart',
          'whatsappWindowClosesAt',
        ]),
        slotsInAnswer: Array.isArray(answer.slots) ? answer.slots : undefined,
        code: bodyCode(data),
      };
    } else if (CANCEL_PATH.test(path)) {
      detail = {
        reason: body.reason ?? null,
        answer: pick(answer, ['id', 'status', 'reason']),
        code: bodyCode(data),
      };
    } else if (STATE_PATH.test(path)) {
      detail = {
        answer: pick(answer, [
          'mode',
          'handoffEpoch',
          'epoch',
          'scheduledRequest',
        ]),
      };
    } else detail = { code: bodyCode(data) };
    line('backend', `${method} ${reportRoute(config.url ?? '')}`, {
      status,
      ...detail,
    });
  };
  const client = observedClient(serviceKey, observe);

  /* ---- the real stack over an in-memory conversation store ---- */
  const store = new InMemoryConversationStore();
  const registry = new InMemoryHumanRequestFeedStore();
  const outboxStore = new InMemoryBackendOutboxStore();
  const state = new SchedulingStateService({
    store,
    live: { getConversationState: (ref) => client.getConversationState(ref) },
  });

  const slotAnswers: ListSlotsResult[] = [];
  const rescheduleCalls: Array<{
    requestId: string;
    scheduledFor: string;
    key: string;
    realKind: string;
    toldKind: string;
    result: RescheduleRequestResult;
  }> = [];
  let loseNextReschedule = false;
  const scheduling: SchedulingClient = {
    listSlots: async (input) => {
      if (!isIsoInstant(input.lastCustomerMessageAt))
        problem('listSlots called without lastCustomerMessageAt');
      const result = await client.listSlots(input);
      slotAnswers.push(result);
      return result;
    },
    rescheduleRequest: async (requestId, input, idempotencyKey) => {
      if (!isIsoInstant(input.lastCustomerMessageAt))
        problem('rescheduleRequest called without lastCustomerMessageAt');
      const result = await client.rescheduleRequest(
        requestId,
        input,
        idempotencyKey,
      );
      let told: RescheduleRequestResult = result;
      if (loseNextReschedule) {
        // The retry drill: the backend DID process the call, the bot never
        // saw the answer (a timeout after the commit).
        loseNextReschedule = false;
        told = {
          kind: 'RETRYABLE',
          cause: 'timeout',
          status: null,
          retryAfterSeconds: null,
        };
        line('drill', 'reschedule answer lost', {
          backendAnswered: result.kind,
          botIsTold: told.kind,
        });
      }
      rescheduleCalls.push({
        requestId,
        scheduledFor: input.scheduledFor,
        key: idempotencyKey,
        realKind: result.kind,
        toldKind: told.kind,
        result,
      });
      return told;
    },
  };

  const createCalls: Array<{
    input: CreateHumanRequestInput;
    result: CreateHumanRequestResult | 'threw';
  }> = [];
  const requests: Pick<
    HumanRequestsClient,
    'createHumanRequest' | 'cancelHumanRequest'
  > = {
    createHumanRequest: async (input) => {
      if (
        'scheduledFor' in input &&
        input.scheduledFor !== undefined &&
        !isIsoInstant(input.lastCustomerMessageAt)
      )
        problem('createHumanRequest called without lastCustomerMessageAt');
      try {
        const result = await client.createHumanRequest(input);
        createCalls.push({ input, result });
        return result;
      } catch (error) {
        createCalls.push({ input, result: 'threw' });
        throw error;
      }
    },
    cancelHumanRequest: (...rest) => client.cancelHumanRequest(...rest),
  };

  // The unscheduled create (and its outbox): a scheduled booking must never
  // reach it.
  let unscheduledCreates = 0;
  const realTeam = new HumanRequestCreateService({
    client: requests,
    store: registry,
    outbox: new BackendOutboxService(outboxStore),
    sender: {
      sendText: () =>
        Promise.resolve({ providerMessageId: 'wamid.e2e-unused' }),
    },
    handoff: { isHumanMode: () => Promise.resolve(false) },
    isWindowOpen: () => Promise.resolve(true),
  });
  const team = {
    requestTalkToHuman: (
      input: Parameters<typeof realTeam.requestTalkToHuman>[0],
    ) => {
      unscheduledCreates += 1;
      return realTeam.requestTalkToHuman(input);
    },
  };

  const policy = new SchedulingOutOfHoursPolicy({
    scheduling,
    requests,
    state,
    team,
    registry,
    appointments: new AppointmentIntentService({
      scheduling,
      requests,
      state,
      registry,
    }),
  });

  line('config', 'ok', {
    phase: 'schedule',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: maskConversationRef(conversationRef),
    cancel: args.cancel,
    retryDrill: args.drill,
    stack:
      'real SchedulingOutOfHoursPolicy + AppointmentIntentService + SchedulingStateService over InMemoryConversationStore; real ChatbotApiHttpClient (SCHEDULING_CLIENT); real styling; nothing is sent to WhatsApp',
  });

  /* ---- helpers ---- */
  let messageCounter = 0;
  const inboundAtOf = new Map<string, string>();
  const newMessageId = () => {
    messageCounter += 1;
    return `wamid.e2e-sched-${runId}-${messageCounter}`;
  };
  const lastSlotsOk = () => {
    for (let i = slotAnswers.length - 1; i >= 0; i -= 1) {
      const answer = slotAnswers[i];
      if (answer.kind === 'ok') return answer;
    }
    return null;
  };
  /** Prints the bot's reply (as the dispatcher sends it to a usted customer,
   *  and its tú rendering) and checks the usted text against the approved
   *  builders' output. */
  const reply = (
    step: string,
    outcome: { kind: 'pass' } | { kind: 'reply'; text: string },
    approved: readonly string[],
  ): void => {
    if (outcome.kind === 'pass') {
      line(
        step,
        'bot: no scheduling reply (pass: the normal LLM turn would run)',
        {},
      );
      return;
    }
    line(step, 'bot reply', {
      text: asSent(outcome.text, DEFAULT_CUSTOMER_STYLE),
      tuText: asSent(outcome.text, TU_STYLE),
    });
    if (!approved.includes(outcome.text))
      problem(
        `${step}: the reply is not an approved builder's output: ${JSON.stringify(outcome.text)} (expected one of ${JSON.stringify(approved)})`,
      );
  };
  const customerSays = (
    step: string,
    text: string,
    messageId: string = newMessageId(),
  ) => {
    line(step, 'customer says', { text });
    // A redelivered message keeps its original timestamp (so a retry sends
    // the same body under the same idempotency key, as production does).
    let inboundAt = inboundAtOf.get(messageId);
    if (inboundAt === undefined) {
      inboundAt = new Date().toISOString();
      inboundAtOf.set(messageId, inboundAt);
    }
    return policy.handleReply({ senderId, text, inboundAt, messageId });
  };
  const finish = (): void => {
    line('summary', problems.length === 0 ? 'ok' : 'FAILED', {
      conversation: maskConversationRef(conversationRef),
      backendCalls: wire.length,
      outboxRows: outboxStore.snapshot().length,
      unscheduledCreates,
      problems,
    });
    if (problems.length > 0) process.exitCode = 1;
  };

  /* ---- a) the ask ---- */
  const askNow = new Date();
  const plan = await policy.planAsk({
    senderId,
    inboundAt: askNow.toISOString(),
    triggerWaMessageId: newMessageId(),
  });
  const asked = lastSlotsOk();
  line('a', 'planAsk', {
    customerSaid: 'quiero hablar con una persona',
    plan: plan.kind,
    openNow: asked?.businessHours.openNow ?? null,
    nextOpenAt: asked?.businessHours.nextOpenAt ?? null,
    timeZone: asked?.timeZone ?? null,
    slots: asked?.slots ?? null,
  });
  if (asked === null) {
    const last = slotAnswers[slotAnswers.length - 1];
    problem(
      `a: no slots answer to work with (${last === undefined ? 'no call' : last.kind}); is scheduling enabled for the branch?`,
    );
    finish();
    return;
  }
  const askedWhen =
    asked.businessHours.nextOpenAt === null
      ? null
      : formatWhen(asked.businessHours.nextOpenAt, asked.timeZone, askNow);
  let closedOffer = false;
  if (plan.kind === 'reply') {
    closedOffer = true;
    reply(
      'a',
      plan,
      askedWhen === null
        ? []
        : [
            offerText(
              askedWhen,
              asked.slots
                .slice(0, 3)
                .map((slot) =>
                  slotLabel(slot.startsAt, asked.timeZone, new Date()),
                ),
            ),
          ],
    );
  } else if (plan.kind === 'create_then_reply') {
    reply(
      'a',
      { kind: 'reply', text: plan.closedReply },
      askedWhen === null ? [] : [noSlotsText(askedWhen)],
    );
    problem(
      'a: the branch is closed but has no free slot: nothing can be booked (the caller would create the unscheduled request)',
    );
    finish();
    return;
  } else if (asked.businessHours.openNow) {
    line('a', 'branch is OPEN now', {
      note: 'the out-of-hours offer cannot be exercised right now; the change / cancel paths run against a booking of the first slot',
    });
    if (asked.slots.length === 0) {
      problem('a: the branch is open but has no free slot to book');
      finish();
      return;
    }
    await state.storeOffer(
      senderId,
      offerFromSlots(asked, askNow, randomUUID()),
    );
  } else {
    problem(
      `a: planAsk answered "default" although the branch is closed (nextOpenAt=${String(asked.businessHours.nextOpenAt)})`,
    );
    finish();
    return;
  }

  /* ---- b) the booking, inline ---- */
  const offerStored = (await state.read(senderId)).offer;
  if (offerStored === null) {
    problem('b: no offer is stored');
    finish();
    return;
  }
  const bookDigit = closedOffer && offerStored.slots.length >= 2 ? '2' : '1';
  const createsBefore = createCalls.length;
  const booked = await customerSays('b', bookDigit);
  const created = createCalls.slice(createsBefore);
  const lastCreate = created[created.length - 1];
  const bookingResult = lastCreate?.result;
  const bookingOk =
    bookingResult !== undefined &&
    bookingResult !== 'threw' &&
    bookingResult.kind === 'ok'
      ? bookingResult.response
      : null;
  const bookNow = new Date();
  const zone = offerStored.timeZone;
  const bookedApproved: string[] = [];
  if (bookingOk !== null && bookingOk.scheduledFor !== undefined) {
    const label = slotLabel(bookingOk.scheduledFor, zone, bookNow);
    bookedApproved.push(bookedText(label), bookedOutOfWindowText(label));
  } else if (
    bookingResult !== undefined &&
    bookingResult !== 'threw' &&
    bookingResult.kind === 'ALREADY_SCHEDULED'
  ) {
    bookedApproved.push(
      alreadyBookedText(slotLabel(bookingResult.scheduledFor, zone, bookNow)),
    );
  } else if (
    bookingResult !== undefined &&
    bookingResult !== 'threw' &&
    bookingResult.kind === 'SLOT_UNAVAILABLE'
  ) {
    const taken = bookingResult;
    bookedApproved.push(
      slotTakenText(
        taken.slots
          .slice(0, 3)
          .map((slot) => slotLabel(slot.startsAt, taken.timeZone, bookNow)),
      ),
    );
  }
  const bookingKind =
    bookingResult === undefined
      ? 'none'
      : bookingResult === 'threw'
        ? 'threw'
        : bookingResult.kind;
  line('b', 'booking', {
    attempts: created.length,
    resultKind: bookingKind,
    requestId:
      bookingOk === null ? null : (bookingOk.mergedIntoId ?? bookingOk.id),
    folio: bookingOk?.folio ?? null,
    outcome: bookingOk?.outcome ?? null,
    scheduledFor: bookingOk?.scheduledFor ?? null,
    scheduleVersion: bookingOk?.scheduleVersion ?? null,
    requiresTemplateAtStart: bookingOk?.requiresTemplateAtStart ?? null,
    inline: bookingOk !== null,
    outboxRows: outboxStore.snapshot().length,
    unscheduledCreates,
  });
  reply('b', booked, bookedApproved);
  if (booked.kind === 'pass')
    problem('b: the booking did not produce a booked reply');
  if (bookingOk === null) {
    if (bookingKind !== 'ALREADY_SCHEDULED')
      problem(
        `b: the booking was not an inline 2xx scheduled answer (${bookingKind})`,
      );
    else
      line('b', 'ALREADY_SCHEDULED', {
        note: 'this phone already holds an open scheduled request; the run continues with it',
      });
  } else if (
    bookingOk.scheduledFor === undefined ||
    bookingOk.scheduleVersion === undefined
  )
    problem('b: the booking answer carries no scheduledFor / scheduleVersion');
  if (outboxStore.snapshot().length > 0)
    problem('b: the outbox was used (a booking must be inline)');
  if (unscheduledCreates > 0)
    problem('b: the unscheduled create was called during the booking');

  let appointment = await state.findAppointment(senderId);
  if (appointment === null) {
    problem('b: no appointment is stored after the booking');
    finish();
    return;
  }
  const requestId = appointment.requestId;
  line('b', 'stored appointment', {
    requestId,
    scheduledFor: appointment.scheduledFor,
    scheduleVersion: appointment.scheduleVersion,
    timeZone: appointment.timeZone,
    rescheduleCount: appointment.rescheduleCount,
  });

  /* ---- c) what time ---- */
  const whatNow = new Date();
  const whatTime = await customerSays('c', '¿a qué hora quedé?');
  reply('c', whatTime, [
    whatTimeText(
      slotLabel(
        appointment.scheduledFor,
        appointment.timeZone ?? zone,
        whatNow,
      ),
    ),
  ]);

  /* ---- d) change the appointment ---- */
  const offerAsk = await customerSays('d', 'quiero cambiar mi cita');
  const rescheduleOffer = (await state.read(senderId)).offer;
  if (
    rescheduleOffer === null ||
    rescheduleOffer.rescheduleRequestId === undefined
  ) {
    reply('d', offerAsk, []);
    problem('d: no reschedule offer was stored');
    finish();
    return;
  }
  const offerNow = new Date();
  reply('d', offerAsk, [
    rescheduleOfferText(
      rescheduleOffer.slots.map((slot) =>
        slotLabel(slot.startsAt, rescheduleOffer.timeZone, offerNow),
      ),
    ),
  ]);
  // Pick a slot other than the current time (a reschedule to the same slot is
  // UNCHANGED and proves little).
  const currentMs = Date.parse(appointment.scheduledFor);
  let pickIndex = rescheduleOffer.slots.findIndex(
    (slot) => Date.parse(slot.startsAt) !== currentMs,
  );
  if (pickIndex < 0) pickIndex = 0;
  const target = rescheduleOffer.slots[pickIndex].startsAt;
  const rescheduleDigit = String(pickIndex + 1);
  const rescheduleMessageId = newMessageId();
  const callsBefore = rescheduleCalls.length;
  if (args.drill) {
    loseNextReschedule = true;
    const lost = await customerSays('d', rescheduleDigit, rescheduleMessageId);
    if (lost.kind !== 'pass')
      problem(
        'd: with the first reschedule answer lost the bot should say nothing (offer and key kept)',
      );
    else
      line(
        'd',
        'bot: no scheduling reply (pass) — offer and key kept for the retry',
        {},
      );
    line(
      'd',
      'the customer retries the same choice (same message redelivered)',
      {},
    );
  }
  const rescheduled = await customerSays(
    'd',
    rescheduleDigit,
    rescheduleMessageId,
  );
  const made = rescheduleCalls.slice(callsBefore);
  const finalCall = made[made.length - 1];
  const finalOk =
    finalCall !== undefined && finalCall.result.kind === 'ok'
      ? finalCall.result
      : null;
  line('d', 'reschedule', {
    target,
    calls: made.map((call) => ({
      key: shortKey(call.key),
      scheduledFor: call.scheduledFor,
      backendAnswered: call.realKind,
      botWasTold: call.toldKind,
    })),
    status: finalOk?.status ?? null,
    scheduledFor: finalOk?.scheduledFor ?? null,
    previousScheduledFor: finalOk?.previousScheduledFor ?? null,
    scheduleVersion: finalOk?.scheduleVersion ?? null,
  });
  // The same retry must replay the same key (idempotency), never a new one.
  if (args.drill && made.length < 2)
    problem('d: the retry never reached the backend (expected a second call)');
  for (let i = 1; i < made.length; i += 1) {
    const before = made[i - 1];
    const after = made[i];
    if (
      before.requestId === after.requestId &&
      before.scheduledFor === after.scheduledFor &&
      before.toldKind !== 'ok' &&
      before.toldKind !== 'SLOT_UNAVAILABLE' &&
      before.key !== after.key
    )
      problem(
        `d: the reschedule retry did not reuse its idempotency key (${String(shortKey(before.key))} then ${String(shortKey(after.key))})`,
      );
  }
  reply('d', rescheduled, [
    rescheduledText(slotLabel(target, rescheduleOffer.timeZone, new Date())),
  ]);
  if (
    finalOk !== null &&
    Date.parse(finalOk.scheduledFor) !== Date.parse(target)
  )
    problem('d: the rescheduled time is not the chosen slot');
  appointment = await state.findAppointment(senderId);
  line('d', 'stored appointment', {
    requestId: appointment?.requestId ?? null,
    scheduledFor: appointment?.scheduledFor ?? null,
    scheduleVersion: appointment?.scheduleVersion ?? null,
    timeZone: appointment?.timeZone ?? null,
    rescheduleCount: appointment?.rescheduleCount ?? null,
  });
  if (
    appointment === null ||
    Date.parse(appointment.scheduledFor) !== Date.parse(target)
  ) {
    problem('d: the stored appointment does not hold the chosen slot');
    finish();
    return;
  }

  /* ---- e) hand over to the parent (staff reschedule) / cancel ---- */
  const cursor = await readTail(client);
  line('e', 'for the staff reschedule and --phase schedule-feed', {
    requestId,
    cursor,
    scheduledFor: appointment?.scheduledFor ?? null,
    scheduleVersion: appointment?.scheduleVersion ?? null,
    timeZone: appointment?.timeZone ?? null,
  });
  if (args.cancel) {
    const cancelled = await customerSays('e', 'cancela mi cita');
    reply('e', cancelled, [cancelledText()]);
    const after = await state.findAppointment(senderId);
    const row = await registry.getRequest(requestId);
    line('e', 'after the cancel', {
      appointmentStored: after !== null,
      registryStatus: row?.status ?? null,
    });
    if (after !== null)
      problem('e: the appointment is still stored after the cancel');
  }
  finish();
}

/**
 * `--phase schedule-feed` (unit 14 T7): consumes the scheduled feed items of
 * ONE request from `--after` with the REAL `HumanRequestFeedConsumer`,
 * `HumanRequestDeliveryService` and `ScheduledConversationService`
 * (`SCHEDULED_APPOINTMENT_READER` / `WRITER` = `StoredAppointmentReader` /
 * `SchedulingStateService` over an in-memory store seeded with the
 * appointment of `--scheduled-for` / `--version`), the real
 * `ChatbotApiHttpClient` and the real `MetaWhatsappSender` over a stub
 * transport (Meta is never called). WRITES DEV DATA: the outcome ACKs. Items
 * of other requests, and live items of this one, are skipped (never handled
 * or ACKed). Stops after the first handled `conversation.rescheduled` /
 * `conversation.scheduled_reminder` of the request, or at the time bound.
 */
async function runScheduleFeed(args: Args, serviceKey: string): Promise<void> {
  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const [requestId] = args.requests;
  const scheduledFor = args.scheduledFor as string;
  const version = args.version as number;
  const senderId = `521${args.phone}`;
  const conversationRef = `wa:${senderId}`;
  const masked = maskConversationRef(conversationRef);
  const problems: string[] = [];
  const problem = (message: string) => {
    problems.push(message);
    line('problem', 'FOUND', { message });
  };

  const outcomeAcks: Array<{
    deliveryId: string;
    outcome: string | null;
    http: number | null;
    code: string | null;
  }> = [];
  const client = observedClient(serviceKey, (config, status, data) => {
    const match = OUTCOME_URL.exec(config.url ?? '');
    if (match === null) return;
    const request = jsonObject(config.data);
    const ack = {
      deliveryId: decodeURIComponent(match[1]),
      outcome: typeof request.outcome === 'string' ? request.outcome : null,
      http: status,
      code: bodyCode(data),
    };
    outcomeAcks.push(ack);
    line('schedule-feed', 'outcome-ack', ack);
  });

  /* ---- local state seeded with the appointment ---- */
  const store = new InMemoryConversationStore();
  const handoff = new HandoffModeService(store);
  const state = new SchedulingStateService({
    store,
    live: { getConversationState: (ref) => client.getConversationState(ref) },
  });
  const feedStore = new InMemoryHumanRequestFeedStore();
  await feedStore.recordOpenRequest({
    requestId,
    conversationRef,
    subtype: 'TALK_TO_HUMAN',
    legacyId: null,
  });
  await state.bookAppointment(senderId, {
    requestId,
    subtype: 'TALK_TO_HUMAN',
    scheduledFor,
    scheduleVersion: version,
    timeZone: null,
    rescheduleCount: 0,
  });

  /* ---- the real Meta sender over a stub transport ---- */
  const sends: Array<{ wamid: string; text: string | null }> = [];
  const transport = new HttpService();
  (transport as { post: unknown }).post = (_url: string, payload: unknown) =>
    defer(() => {
      const body = payload as MetaStubPayload;
      const wamid = `wamid.e2e-${runId}-${sends.length + 1}`;
      sends.push({ wamid, text: body.text?.body ?? null });
      return Promise.resolve({
        data: { messages: [{ id: wamid }] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      });
    });
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
  );

  const isWindowOpen = () => Promise.resolve(!args.windowClosed);
  const customerStyle = () => Promise.resolve(DEFAULT_CUSTOMER_STYLE);
  const ackResults = new Map<string, RecordDeliveryOutcomeResult | string>();
  const delivery = new HumanRequestDeliveryService({
    store: feedStore,
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
    handoff: { isHumanMode: (id: string) => handoff.isHumanMode(id) },
    isWindowOpen,
    customerStyle,
    scheduled: new ScheduledConversationService({
      store: feedStore,
      isWindowOpen,
      customerStyle,
      appointments: new StoredAppointmentReader({ state, registry: feedStore }),
      appointmentWriter: state,
    }),
  });

  const ALLOWED_ACKS = new Set([
    'PROVIDER_ACCEPTED',
    'DELIVERY_UNKNOWN',
    'STALE',
  ]);
  let handledScheduled = 0;
  let skipped = 0;
  // SAFETY: `consume` only calls accept / abandon / sweepAcks on the delivery
  // service; the object below implements exactly those three.
  const observed = {
    accept: async (item: FeedItem) => {
      if (!isScheduledConversationItem(item)) return;
      const sendsBefore = sends.length;
      const before = await state.findAppointment(senderId);
      await delivery.accept(item);
      const row = await feedStore.getDelivery(item.deliveryId);
      const after = await state.findAppointment(senderId);
      const ack = ackHttp.get(item.deliveryId);
      const sent = sends.slice(sendsBefore);
      const { payload } = item;
      line('schedule-feed', 'item', {
        cursor: item.cursor,
        type: item.type,
        requestId: payload.requestId,
        scheduledFor: payload.scheduledFor,
        previousScheduledFor:
          item.type === 'conversation.rescheduled'
            ? item.payload.previousScheduledFor
            : undefined,
        scheduleVersion: payload.scheduleVersion,
        timeZone: payload.timeZone,
        decision: row?.decision ?? null,
        localState: row?.localState ?? null,
        ackOutcome: row?.ackOutcome ?? null,
        ackState: row?.ackState ?? null,
        ackHttp: ack?.status ?? null,
        ackCode: ack?.code ?? null,
        ackResult: renderAckResult(ackResults.get(item.deliveryId)),
        sends: sent.map((entry) => ({ wamid: entry.wamid, text: entry.text })),
        appointmentBefore: before,
        appointmentAfter: after,
      });
      handledScheduled += 1;

      // --- assertions ---
      const outcome = row?.ackOutcome ?? null;
      if (outcome === null)
        problem(`${item.type}: no outcome ACK was recorded`);
      else {
        if (!ALLOWED_ACKS.has(outcome))
          problem(
            `${item.type}: ACK outcome ${outcome} is not one of PROVIDER_ACCEPTED / DELIVERY_UNKNOWN / STALE`,
          );
        if (ack?.status !== 200)
          problem(
            `${item.type}: the outcome ACK answered HTTP ${String(ack?.status ?? null)} ${String(ack?.code ?? '')}`.trim(),
          );
      }
      if (sent.length > 1) problem(`${item.type}: more than one message sent`);
      if (sent.length === 0 && outcome !== 'STALE')
        problem(`${item.type}: nothing was sent and the ACK is not STALE`);
      if (sent.length === 1) {
        let zone = DEFAULT_ZONE_FOR_REPORT;
        for (const candidate of [payload.timeZone, before?.timeZone]) {
          if (typeof candidate !== 'string' || candidate === '') continue;
          try {
            new Intl.DateTimeFormat('es-MX', { timeZone: candidate });
            zone = candidate;
            break;
          } catch {
            // an unusable zone: try the next one
          }
        }
        const expected =
          item.type === 'conversation.scheduled_reminder'
            ? reminderText(formatClock(payload.scheduledFor, zone))
            : staffChangedText(
                slotLabel(payload.scheduledFor, zone, new Date()),
              );
        if (sent[0].text !== asSent(expected, DEFAULT_CUSTOMER_STYLE))
          problem(
            `${item.type}: the sent text is not the approved builder's output: ${JSON.stringify(sent[0].text)} (expected ${JSON.stringify(expected)})`,
          );
        if (outcome !== 'PROVIDER_ACCEPTED' && outcome !== 'DELIVERY_UNKNOWN')
          problem(
            `${item.type}: a message was sent but the ACK is ${String(outcome)}`,
          );
      }
      if (
        item.type === 'conversation.rescheduled' &&
        (after === null ||
          Date.parse(after.scheduledFor) !== Date.parse(payload.scheduledFor) ||
          after.scheduleVersion !== payload.scheduleVersion)
      )
        problem(
          'conversation.rescheduled: the stored appointment does not hold the item time and version',
        );
    },
    abandon: (item: FeedItem, reason: Parameters<typeof delivery.abandon>[1]) =>
      delivery.abandon(item, reason),
    sweepAcks: () => delivery.sweepAcks(),
  } as unknown as HumanRequestDeliveryService;

  line('config', 'ok', {
    phase: 'schedule-feed',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: masked,
    request: requestId,
    after: args.after,
    minutes: args.minutes,
    seededAppointment: { scheduledFor, scheduleVersion: version },
    windowStub: args.windowClosed ? 'closed' : 'open',
    sender: 'real MetaWhatsappSender over a stub transport (no Meta call)',
  });
  // writeSync: a background log shows the line immediately.
  writeSync(
    1,
    `[consume] listening cursor=${JSON.stringify(args.after)} request=${JSON.stringify(requestId)}\n`,
  );

  await consume(
    args,
    client,
    feedStore,
    observed,
    args.after,
    new Set([requestId]),
    ackResults,
    {
      done: () => handledScheduled > 0,
      skip: (item) => {
        if (
          isScheduledConversationItem(item) &&
          item.payload.requestId === requestId
        )
          return false;
        skipped += 1;
        if (skipped <= 20)
          line(
            'schedule-feed',
            'skipped (not a scheduled item of the request)',
            {
              cursor: item.cursor,
              type:
                item.type === 'unknown' ? `unknown:${item.rawType}` : item.type,
            },
          );
        return true;
      },
    },
  );
  if (skipped > 0) line('schedule-feed', 'skipped items', { count: skipped });

  if (handledScheduled === 0)
    problem(
      'no conversation.rescheduled / conversation.scheduled_reminder of the request was handled (time bound)',
    );
  const stored = await state.findAppointment(senderId);
  line('schedule-feed', 'stored appointment after', { appointment: stored });
  line('summary', problems.length === 0 ? 'ok' : 'FAILED', {
    conversation: masked,
    handled: handledScheduled,
    ackOutcomes: outcomeAcks.map((ack) => ({
      outcome: ack.outcome,
      http: ack.http,
      code: ack.code,
    })),
    problems,
  });
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  line('fatal', 'error', describeError(error));
  process.exitCode = 1;
});
