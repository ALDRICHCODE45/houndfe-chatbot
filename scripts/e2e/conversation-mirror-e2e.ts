/** Spec S8 end-to-end run of the conversation mirror and media (backend
 * unit 9) against a DEV backend. Drives the REAL ChatbotApiHttpClient
 * methods `uploadMedia`, `mirrorMessages` and `recordMessageStatuses`:
 *   1. upload a tiny generated PNG (and again with the same key → replay),
 *   2. mirror a conversation (text, options, button reply, image,
 *      unsupported location, text),
 *   3. resend the same batch (all duplicates),
 *   4. record delivery statuses (SENT → DELIVERED → READ, FAILED, unknown).
 * WRITES DEV DATA on the backend; the chatbot Postgres DB is never touched.
 * Never prints the service key, request headers, the phone or the full
 * conversationRef (S6: masked to its last 4 digits). Exits non-zero on any
 * non-ok result, printing the typed failure kind/code. See
 * scripts/e2e/README.md.
 *
 * `--phase outbox` (default is the client-level flow above) runs the REAL
 * delivery stack instead: in-memory backend outbox, the production enqueue
 * API and payload builder, the drain worker, the routing delivery with the
 * mirror and status adapters, the media service and the HTTP client. See
 * `runOutboxPhase`.
 *
 * `--phase seed-fe` seeds ONE realistic 64-message conversation (plus an
 * open UNKNOWN_QUESTION request) through that same real stack so staff can
 * test the conversation view and "load older" pagination. See
 * `runSeedFePhase`. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';
import type {
  MirrorMessageInput,
  MirrorStatusInput,
} from '../../src/chatbot-api/domain/dtos/conversation-mirror.dto';
import { mediaIdempotencyKey } from '../../src/chatbot-api/domain/uuid-v5';
import { maskConversationRef } from '../../src/human-requests/domain/human-request-feed';
import { BackendOutboxDrainWorker } from '../../src/backend-outbox/application/backend-outbox-drain.worker';
import { BackendOutboxService } from '../../src/backend-outbox/application/backend-outbox.service';
import { conversationRefFor } from '../../src/backend-outbox/domain/backend-outbox';
import { InMemoryBackendOutboxStore } from '../../src/backend-outbox/infrastructure/in-memory-backend-outbox.store';
import { RoutingBackendOutboxDelivery } from '../../src/backend-outbox/infrastructure/routing-backend-outbox.delivery';
import { mirrorPayload } from '../../src/conversation-transcript/application/transcript-recorder';
import type {
  TranscriptMedia,
  TranscriptMessage,
} from '../../src/conversation-transcript/domain/transcript.port';
import { MirrorDeliveryGate } from '../../src/conversation-mirror/application/mirror-delivery-gate';
import { MirrorMediaService } from '../../src/conversation-mirror/application/mirror-media.service';
import { MirrorMessagesDelivery } from '../../src/conversation-mirror/application/mirror-messages.delivery';
import { MirrorStatusesDelivery } from '../../src/conversation-mirror/application/mirror-statuses.delivery';
import type {
  MirrorLinkFetcher,
  MirrorMetaDownloader,
} from '../../src/conversation-mirror/domain/mirror-media';
import { InMemoryMirrorMediaCacheStore } from '../../src/conversation-mirror/infrastructure/in-memory-mirror-media-cache.store';
import { LinkMirrorFetcher } from '../../src/conversation-mirror/infrastructure/link-mirror-fetcher';
import { sniffMirrorMedia } from '../../src/conversation-mirror/infrastructure/mirror-media-profile';
import type { BackendOutboxEntry } from '../../src/backend-outbox/domain/backend-outbox';

const BASE_URL = process.env.CHATBOT_API_BASE_URL ?? 'http://localhost:3003';
const BRANCH_ID =
  process.env.CHATBOT_API_BRANCH_ID ?? 'ced6cc10-a037-4f41-92af-ee69bbb51c8b';
const TOKEN_FILE = '/tmp/houndfe-dev-bot-token.txt';

type Phase = 'client' | 'outbox' | 'seed-fe';

interface Args {
  phase: Phase;
  phone: string;
}

/** `seed-fe` lives OUTSIDE the E2E range (wa:52155500*) on purpose. */
const SEED_FE_DEFAULT_PHONE = '5559990001';
const E2E_PHONE_PREFIX = '55500';

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: conversation-mirror-e2e [--phase client|outbox|seed-fe] [--phone 5550004444]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: 'client', phone: '5550004444' };
  let phoneGiven = false;
  const rest = argv.filter((arg) => arg !== '--');
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--'))
      usage(`missing value for ${flag}`);
    i += 1;
    if (flag === '--phone') {
      if (!/^[0-9]{10}$/.test(value)) usage('--phone must be 10 digits');
      args.phone = value;
      phoneGiven = true;
    } else if (flag === '--phase') {
      if (value !== 'client' && value !== 'outbox' && value !== 'seed-fe')
        usage('--phase must be client, outbox or seed-fe');
      args.phase = value;
    } else usage(`unknown argument ${flag}`);
  }
  if (args.phase === 'seed-fe') {
    if (!phoneGiven) args.phone = SEED_FE_DEFAULT_PHONE;
    if (args.phone.startsWith(E2E_PHONE_PREFIX))
      usage(
        `--phone for seed-fe must be outside the E2E range (${E2E_PHONE_PREFIX}*)`,
      );
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

/** Typed failure → one line (kind, code, status, flags; never a phone or ref)
 *  and a non-zero exit. */
class StepFailed extends Error {}

function fail(step: string, result: { kind: string }): never {
  const { kind, ...rest } = result as Record<string, unknown>;
  line(step, 'FAILED', { kind, ...rest });
  throw new StepFailed(`${step} failed: ${String(kind)}`);
}

/* ---- Tiny valid PNG (passes the backend's byte sniffing) ---- */

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8x8 RGB PNG of one random colour (so each run has its own bytes). */
function tinyPng(): Buffer {
  const size = 8;
  const [r, g, b] = randomBytes(3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type RGB
  const row = Buffer.concat([
    Buffer.from([0]), // filter: none
    Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b]))),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** L7c: the service key and the (masked) conversation travel to this URL, so
 * a cleartext `http:` base is refused unless the host is loopback (the local
 * dev backend). Checked before the token file is read. */
export function assertSecureBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    usage('CHATBOT_API_BASE_URL is not a valid URL');
  }
  if (url.username !== '' || url.password !== '')
    usage('CHATBOT_API_BASE_URL must not carry credentials');
  if (url.protocol === 'https:') return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  if (url.protocol === 'http:' && loopback) return;
  usage(
    'CHATBOT_API_BASE_URL must be https (http is only allowed for a loopback host)',
  );
}

async function runClientPhase(args: Args): Promise<void> {
  const serviceKey = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (serviceKey === '') usage(`empty token file ${TOKEN_FILE}`);

  const config = new ConfigService({
    chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
  });
  const client = new ChatbotApiHttpClient(
    new HttpService(axios.create()),
    config,
  );

  const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const conversationRef = `wa:521${args.phone}`;
  const masked = maskConversationRef(conversationRef);
  line('config', 'ok', {
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: masked,
  });

  /* ---- 1. media upload + idempotent replay ---- */
  const dir = mkdtempSync(join(tmpdir(), 'conversation-mirror-e2e-'));
  const filePath = join(dir, `e2e-${runId}.png`);
  writeFileSync(filePath, tinyPng());
  const key = mediaIdempotencyKey(`e2e-image-${runId}`);

  const first = await client.uploadMedia({
    filePath,
    filename: `e2e-${runId}.png`,
    idempotencyKey: key,
  });
  if (first.kind !== 'ok') fail('media.upload', first);
  line('media.upload', 'ok', {
    mediaId: first.mediaId,
    created: first.created,
    mimeType: first.mimeType,
    sizeBytes: first.sizeBytes,
    sha256: first.sha256,
  });
  const replay = await client.uploadMedia({
    filePath,
    filename: `e2e-${runId}.png`,
    idempotencyKey: key,
  });
  if (replay.kind !== 'ok') fail('media.replay', replay);
  line('media.replay', replay.created ? 'UNEXPECTED created=true' : 'ok', {
    mediaId: replay.mediaId,
    created: replay.created,
    sameMediaId: replay.mediaId === first.mediaId,
  });
  if (replay.created || replay.mediaId !== first.mediaId) {
    process.exitCode = 1;
  }

  /* ---- 2. mirror the conversation ---- */
  const wamid = (n: number) => `wamid.e2e-${runId}-${n}`;
  const base = Date.now() - 60_000;
  const at = (n: number) => new Date(base + n * 1_000).toISOString();
  const observed = (n: number) =>
    new Date(base + n * 1_000 + 500).toISOString();
  const stamps = (n: number) => ({
    providerTimestamp: at(n),
    observedAt: observed(n),
  });
  const messages: MirrorMessageInput[] = [
    {
      waMessageId: wamid(1),
      direction: 'IN',
      type: 'TEXT',
      text: 'Hola, ¿tienen croquetas para cachorro?',
      ...stamps(1),
    },
    {
      waMessageId: wamid(2),
      direction: 'OUT',
      type: 'TEXT',
      text: 'Con gusto le ayudo…\n\nOpciones: Sí · No · Hablar con alguien',
      ...stamps(2),
    },
    {
      waMessageId: wamid(3),
      direction: 'IN',
      type: 'TEXT',
      text: 'Sí',
      ...stamps(3),
    },
    {
      waMessageId: wamid(4),
      direction: 'IN',
      type: 'IMAGE',
      mediaId: first.mediaId,
      ...stamps(4),
    },
    {
      waMessageId: wamid(5),
      direction: 'IN',
      type: 'UNSUPPORTED',
      kind: 'LOCATION',
      ...stamps(5),
    },
    {
      waMessageId: wamid(6),
      direction: 'OUT',
      type: 'TEXT',
      text: 'Gracias, ya lo reviso y le confirmo.',
      ...stamps(6),
    },
  ];

  const mirrored = await client.mirrorMessages(conversationRef, messages);
  if (mirrored.kind !== 'ok') fail('mirror', mirrored);
  line('mirror', 'ok', {
    sent: messages.length,
    accepted: mirrored.accepted.map((m) => ({
      waMessageId: m.waMessageId,
      seq: m.seq,
    })),
    duplicates: mirrored.duplicates,
  });
  if (
    mirrored.accepted.length !== messages.length ||
    mirrored.duplicates.length !== 0
  ) {
    line('mirror', 'UNEXPECTED: first send was not all accepted', {});
    process.exitCode = 1;
  }

  /* ---- 3. resend the exact same batch ---- */
  const resent = await client.mirrorMessages(conversationRef, messages);
  if (resent.kind !== 'ok') fail('mirror.resend', resent);
  const allDuplicates =
    resent.accepted.length === 0 &&
    resent.duplicates.length === messages.length;
  line('mirror.resend', allDuplicates ? 'ok' : 'UNEXPECTED', {
    accepted: resent.accepted.length,
    duplicates: resent.duplicates,
    allDuplicates,
  });
  if (!allDuplicates) process.exitCode = 1;

  /* ---- 4. delivery statuses ---- */
  const t = Date.now();
  const when = (offsetMs: number) => new Date(t + offsetMs).toISOString();
  const unknownId = `wamid.e2e-${runId}-unknown`;
  const statuses: MirrorStatusInput[] = [
    { providerMessageId: wamid(2), status: 'SENT', occurredAt: when(-3_000) },
    {
      providerMessageId: wamid(2),
      status: 'DELIVERED',
      occurredAt: when(-2_000),
    },
    { providerMessageId: wamid(2), status: 'READ', occurredAt: when(-1_000) },
    {
      providerMessageId: wamid(6),
      status: 'FAILED',
      occurredAt: when(-500),
      errorCode: '131026',
    },
    { providerMessageId: unknownId, status: 'SENT', occurredAt: when(0) },
  ];
  const recorded = await client.recordMessageStatuses(statuses);
  if (recorded.kind !== 'ok') fail('statuses', recorded);
  line('statuses', 'ok', {
    sent: statuses.length,
    applied: recorded.applied,
    ignored: recorded.ignored,
    unknown: recorded.unknown,
  });
  if (!recorded.unknown.includes(unknownId)) {
    line('statuses', 'UNEXPECTED: the unknown id was not reported unknown', {});
    process.exitCode = 1;
  }

  /* ---- 5. masked summary for the backend staff read ---- */
  line('summary', 'conversation', {
    conversation: masked,
    mediaId: first.mediaId,
    messages: messages.map((m) => ({
      waMessageId: m.waMessageId,
      direction: m.direction,
      type: m.type,
    })),
    statusTargets: {
      readOrDelivered: wamid(2),
      failed: wamid(6),
      unknown: unknownId,
    },
  });
  line('summary', process.exitCode ? 'FAILED' : 'ok', {
    note: 'staff read: look for the waMessageIds above in the inbox of the masked conversation',
  });
}

/* ======================================================================
 * --phase outbox: the real delivery stack against the dev backend
 * ====================================================================== */

/** Small public HTTPS PNG used as the "product photo" (stable, ETag'd). */
const PRODUCT_PHOTO_URL =
  'https://raw.githubusercontent.com/github/explore/main/topics/typescript/typescript.png';
const DRAIN_BOUND_MS = 180_000;
const MIRROR_ROWS = 55;

interface RouteStats {
  requests: number;
  statuses: Map<string, number>;
}

/** The route as the backend sees it, with ids and the conversation ref
 *  replaced (S6: the ref carries the phone). */
function routeKey(method: string, rawUrl: string, baseURL?: string): string {
  let path: string;
  try {
    path = new URL(rawUrl, baseURL).pathname;
  } catch {
    path = '?';
  }
  return `${method.toUpperCase()} ${path
    .replace(/\/conversations\/[^/]+\//, '/conversations/:ref/')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id',
    )}`;
}

/** The real client over an axios instance whose interceptors count every
 *  HTTP call (and its status) per route. */
function countedClient(serviceKey: string): {
  client: ChatbotApiHttpClient;
  routes: Map<string, RouteStats>;
} {
  const routes = new Map<string, RouteStats>();
  const statsFor = (key: string): RouteStats => {
    let stats = routes.get(key);
    if (stats === undefined) {
      stats = { requests: 0, statuses: new Map() };
      routes.set(key, stats);
    }
    return stats;
  };
  const instance = axios.create();
  instance.interceptors.request.use((config) => {
    statsFor(
      routeKey(config.method ?? 'get', config.url ?? '', config.baseURL),
    ).requests += 1;
    return config;
  });
  const record = (
    config: { method?: string; url?: string; baseURL?: string } | undefined,
    status: string,
  ) => {
    if (config === undefined) return;
    const stats = statsFor(
      routeKey(config.method ?? 'get', config.url ?? '', config.baseURL),
    );
    stats.statuses.set(status, (stats.statuses.get(status) ?? 0) + 1);
  };
  instance.interceptors.response.use(
    (response) => {
      record(response.config, String(response.status));
      return response;
    },
    (error: unknown) => {
      if (axios.isAxiosError(error))
        record(error.config, String(error.response?.status ?? 'NETWORK'));
      throw error;
    },
  );
  const config = new ConfigService({
    chatbotApi: { baseUrl: BASE_URL, serviceKey, branchId: BRANCH_ID },
  });
  return {
    client: new ChatbotApiHttpClient(new HttpService(instance), config),
    routes,
  };
}

const callsOf = (routes: Map<string, RouteStats>, key: string): number =>
  routes.get(key)?.requests ?? 0;

const MESSAGES_ROUTE = 'POST /chatbot-api/conversations/:ref/messages:batch';
const STATUSES_ROUTE = 'POST /chatbot-api/messages/statuses:batch';
const MEDIA_ROUTE = 'POST /chatbot-api/media';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function transcriptRow(fields: {
  senderId: string;
  waMessageId: string;
  direction: 'IN' | 'OUT';
  type: string;
  text?: string | null;
  media?: TranscriptMedia | null;
  details?: Record<string, unknown> | null;
  providerTimestamp: string | null;
  observedAt: string;
}): TranscriptMessage {
  return {
    senderId: fields.senderId,
    waMessageId: fields.waMessageId,
    direction: fields.direction,
    author: fields.direction === 'IN' ? 'CUSTOMER' : 'BOT',
    type: fields.type,
    text: fields.text ?? null,
    media: fields.media ?? null,
    details: fields.details ?? null,
    providerTimestamp: fields.providerTimestamp,
    observedAt: fields.observedAt,
    purgeAfter: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  };
}

interface DeliveryStack {
  store: InMemoryBackendOutboxStore;
  outbox: BackendOutboxService;
  worker: BackendOutboxDrainWorker;
  /** Every mediaId resolution the mirror adapter asked for. */
  resolved: Array<{ outcome: string; mediaId?: string; from?: string }>;
}

/** The production delivery pieces wired by hand (no Nest app): in-memory
 *  outbox, drain worker, routing delivery with the mirror and status
 *  adapters, and the media service over the given sources. */
function buildDeliveryStack(deps: {
  client: ChatbotApiHttpClient;
  meta: MirrorMetaDownloader;
  links: MirrorLinkFetcher;
  runId: string;
}): DeliveryStack {
  const { client, meta, links, runId } = deps;
  const store = new InMemoryBackendOutboxStore();
  const outbox = new BackendOutboxService(store);
  const mediaService = new MirrorMediaService({
    client,
    meta,
    links,
    cache: new InMemoryMirrorMediaCacheStore(),
  });
  const resolved: DeliveryStack['resolved'] = [];
  const media: Pick<MirrorMediaService, 'resolveMedia'> = {
    resolveMedia: async (...params) => {
      const outcome = await mediaService.resolveMedia(...params);
      resolved.push(
        outcome.kind === 'ok'
          ? { outcome: 'ok', mediaId: outcome.mediaId, from: outcome.from }
          : { outcome: outcome.kind },
      );
      return outcome;
    },
  };
  const gate = new MirrorDeliveryGate();
  const router = new RoutingBackendOutboxDelivery();
  router.register(
    ['MESSAGE_MIRROR'],
    new MirrorMessagesDelivery({ client, media, gate }),
  );
  router.register(
    ['MESSAGE_STATUS'],
    new MirrorStatusesDelivery({ client, outbox, gate }),
  );
  const worker = new BackendOutboxDrainWorker(store, router, {
    owner: `e2e-${runId}`,
  });
  return { store, outbox, worker, resolved };
}

/** Ticks the worker until nothing is PENDING/IN_FLIGHT or the bound passes. */
async function drainStore(
  store: InMemoryBackendOutboxStore,
  worker: BackendOutboxDrainWorker,
  label: string,
): Promise<number> {
  const deadline = Date.now() + DRAIN_BOUND_MS;
  let ticks = 0;
  while (Date.now() < deadline) {
    const open = store
      .snapshot()
      .some((r) => r.status === 'PENDING' || r.status === 'IN_FLIGHT');
    if (!open) break;
    const claimed = await worker.tick();
    ticks += 1;
    if (claimed === 0) await sleep(500);
  }
  line(label, 'drained', { ticks });
  return ticks;
}

interface RowTally {
  DONE: number;
  RETRY: number;
  DEAD: number;
  PENDING: number;
  IN_FLIGHT: number;
}

/** Prints the row states (RETRY = pending with attempts) and every row that
 *  is not DONE with its truncated last error. */
function summarizeStore(
  store: InMemoryBackendOutboxStore,
  label: string,
): RowTally {
  const rows: BackendOutboxEntry[] = store.snapshot();
  const tally: RowTally = {
    DONE: 0,
    RETRY: 0,
    DEAD: 0,
    PENDING: 0,
    IN_FLIGHT: 0,
  };
  for (const row of rows) {
    if (row.status === 'PENDING' && row.attempts > 0) tally.RETRY += 1;
    else tally[row.status] += 1;
  }
  line(label, 'rows', {
    total: rows.length,
    ...tally,
    byKind: Object.fromEntries(
      ['MESSAGE_MIRROR', 'MESSAGE_STATUS'].map((kind) => [
        kind,
        rows.filter((r) => r.kind === kind).length,
      ]),
    ),
  });
  for (const row of rows.filter(
    (r) => r.status === 'DEAD' || (r.status !== 'DONE' && r.attempts > 0),
  ))
    line(label, 'not-done', {
      kind: row.kind,
      seq: row.seq,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError?.slice(0, 200) ?? null,
    });
  return tally;
}

function printRouteCalls(routes: Map<string, RouteStats>, label: string): void {
  for (const [route, stats] of [...routes.entries()].sort()) {
    line(label, 'http', {
      route,
      calls: stats.requests,
      statuses: Object.fromEntries(stats.statuses),
    });
  }
}

async function runOutboxPhase(args: Args): Promise<void> {
  const serviceKey = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (serviceKey === '') usage(`empty token file ${TOKEN_FILE}`);
  const { client, routes } = countedClient(serviceKey);

  const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const senderId = `521${args.phone}`;
  const conversationRef = conversationRefFor(senderId);
  const masked = maskConversationRef(conversationRef);
  line('config', 'ok', {
    phase: 'outbox',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: masked,
    productPhotoUrl: PRODUCT_PHOTO_URL,
  });

  /* ---- the real stack, built by hand (no Nest app) ---- */
  let linkOpens = 0;
  let metaDownloads = 0;
  const realLinks = new LinkMirrorFetcher({ timeoutMs: 20_000 });
  const links: MirrorLinkFetcher = {
    open: (input) => {
      linkOpens += 1;
      return realLinks.open(input);
    },
  };
  // No IN media in this run: a Meta download would be a script bug.
  const meta: MirrorMetaDownloader = {
    download: () => {
      metaDownloads += 1;
      return Promise.resolve({
        kind: 'unsupported' as const,
        reason: 'media_unavailable' as const,
      });
    },
  };
  const { store, outbox, worker, resolved } = buildDeliveryStack({
    client,
    meta,
    links,
    runId,
  });

  /* ---- enqueue (the production enqueue API and payload builder) ---- */
  const wamid = (n: number | string) => `wamid.e2e-${runId}-${n}`;
  const base = Date.now() - 180_000;
  const stamps = (n: number) => ({
    providerTimestamp: new Date(base + n * 1_000).toISOString(),
    observedAt: new Date(base + n * 1_000 + 500).toISOString(),
  });
  const enqueueMirror = (
    row: TranscriptMessage,
    mutate?: (payload: Record<string, unknown>) => void,
  ) => {
    const payload = mirrorPayload(row);
    mutate?.(payload);
    return outbox.enqueue({
      conversationRef: conversationRefFor(row.senderId),
      kind: 'MESSAGE_MIRROR',
      idempotencyKey: `mirror:${row.waMessageId}`,
      payload,
    });
  };
  const enqueueStatus = (
    providerMessageId: string,
    status: string,
    errorCode?: string,
  ) =>
    outbox.enqueue({
      conversationRef,
      kind: 'MESSAGE_STATUS',
      idempotencyKey: `status:${providerMessageId}:${status}`,
      payload: {
        providerMessageId,
        status,
        occurredAt: new Date().toISOString(),
        ...(errorCode === undefined ? {} : { errorCode }),
      },
    });

  const RACE_ID = wamid(14);
  // The race: a status for an OUT message queued BEFORE its mirror row.
  await enqueueStatus(RACE_ID, 'DELIVERED');
  for (let n = 1; n <= MIRROR_ROWS; n += 1) {
    const direction = n % 2 === 1 ? 'IN' : 'OUT';
    const common = { senderId, waMessageId: wamid(n), ...stamps(n) };
    if (n === 10)
      await enqueueMirror(
        transcriptRow({
          ...common,
          direction: 'OUT',
          type: 'interactive',
          text: 'Con gusto le ayudo. ¿Qué desea hacer?',
          details: { options: ['Sí', 'No', 'Hablar con alguien'] },
        }),
      );
    else if (n === 20)
      await enqueueMirror(
        transcriptRow({
          ...common,
          direction: 'OUT',
          type: 'image',
          text: 'Croquetas para cachorro 1 kg',
          media: { link: PRODUCT_PHOTO_URL },
        }),
      );
    else if (n === 30)
      await enqueueMirror(
        transcriptRow({ ...common, direction: 'IN', type: 'location' }),
      );
    else if (n === 40)
      // Old-style row (enqueued before T2): no providerTimestamp, and none of
      // the contractType / unsupportedKind / options fields.
      await enqueueMirror(
        transcriptRow({
          ...common,
          direction: 'OUT',
          type: 'text',
          text: `Mensaje ${n} de la conversación de prueba`,
          providerTimestamp: null,
        }),
        (payload) => {
          delete payload.contractType;
          delete payload.unsupportedKind;
          delete payload.options;
        },
      );
    else
      await enqueueMirror(
        transcriptRow({
          ...common,
          direction,
          type: 'text',
          text: `Mensaje ${n} de la conversación de prueba`,
        }),
      );
  }
  // Statuses after the mirror, plus one for an id that was never mirrored.
  const GHOST_ID = wamid('ghost');
  for (const n of [2, 4, 6, 10, 20]) await enqueueStatus(wamid(n), 'DELIVERED');
  for (const n of [2, 10, 20]) await enqueueStatus(wamid(n), 'READ');
  await enqueueStatus(wamid(8), 'FAILED', '131026');
  await enqueueStatus(wamid(12), 'SENT');
  await enqueueStatus(GHOST_ID, 'DELIVERED');
  line('enqueue', 'ok', {
    mirrorRows: MIRROR_ROWS,
    statusRows: store.snapshot().filter((r) => r.kind === 'MESSAGE_STATUS')
      .length,
    race: 'status for an OUT message queued before its mirror row',
    ghost: 'status for an id that is never mirrored',
  });

  /* ---- drain ---- */
  const drain = (label: string) => drainStore(store, worker, label);
  const summarizeRows = (label: string) => summarizeStore(store, label);
  const printCalls = (label: string) => printRouteCalls(routes, label);
  const started = Date.now();
  await drain('drain');
  const elapsedMs = Date.now() - started;

  const first = summarizeRows('pass1');
  printCalls('pass1');
  const photo = resolved.find((r) => r.outcome === 'ok');
  line('pass1', 'media', {
    elapsedMs,
    resolved,
    productPhotoMediaId: photo?.mediaId ?? null,
    from: photo?.from ?? null,
    linkOpens,
    metaDownloads,
    messagesCalls: callsOf(routes, MESSAGES_ROUTE),
    expectedMessagesCalls: 2,
    statusCalls: callsOf(routes, STATUSES_ROUTE),
    uploads: callsOf(routes, MEDIA_ROUTE),
  });

  /* ---- second run: a new product-photo row must reuse the cached mediaId ---- */
  const uploadsBefore = callsOf(routes, MEDIA_ROUTE);
  const messageCallsBefore = callsOf(routes, MESSAGES_ROUTE);
  const resolvedBefore = resolved.length;
  await enqueueMirror(
    transcriptRow({
      senderId,
      waMessageId: wamid(MIRROR_ROWS + 1),
      direction: 'OUT',
      type: 'image',
      text: 'Croquetas para cachorro 1 kg (otra vez)',
      media: { link: PRODUCT_PHOTO_URL },
      ...stamps(MIRROR_ROWS + 1),
      providerTimestamp: new Date().toISOString(),
    }),
  );
  await drain('drain2');
  const second = summarizeRows('pass2');
  const reuse = resolved.slice(resolvedBefore).find((r) => r.outcome === 'ok');
  const newUploads = callsOf(routes, MEDIA_ROUTE) - uploadsBefore;
  const reused =
    reuse !== undefined &&
    reuse.mediaId === photo?.mediaId &&
    reuse.from === 'cache' &&
    newUploads === 0;
  line('pass2', reused ? 'ok' : 'UNEXPECTED', {
    reusedMediaId: reuse?.mediaId ?? null,
    sameMediaId: reuse?.mediaId === photo?.mediaId,
    from: reuse?.from ?? null,
    newUploads,
    newMessagesCalls: callsOf(routes, MESSAGES_ROUTE) - messageCallsBefore,
    linkOpens,
  });
  printCalls('final');

  /* ---- verdict ---- */
  const problems: string[] = [];
  if (first.DEAD + second.DEAD > 0) problems.push('DEAD rows');
  if (
    second.RETRY + second.PENDING + second.IN_FLIGHT > 0 ||
    first.IN_FLIGHT > 0
  )
    problems.push('rows left open (RETRY/PENDING/IN_FLIGHT)');
  if (photo?.mediaId === undefined) problems.push('no product photo mediaId');
  if (!reused) problems.push('cached mediaId was not reused without upload');
  if (metaDownloads > 0) problems.push('unexpected Meta download');
  line('summary', problems.length === 0 ? 'ok' : 'FAILED', {
    conversation: masked,
    problems,
  });
  if (problems.length > 0) process.exitCode = 1;
}

/* ======================================================================
 * --phase seed-fe: one realistic 64-message conversation for the frontend
 * ====================================================================== */

/** A PNG of a warm gradient with a darker "paw" square: the dog photo. */
function dogPhotoPng(): Buffer {
  const width = 160;
  const height = 120;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const paw = x > 60 && x < 100 && y > 40 && y < 85;
      row[1 + x * 3] = paw ? 90 : 200 - Math.floor((y * 80) / height);
      row[2 + x * 3] = paw ? 60 : 150 - Math.floor((x * 60) / width);
      row[3 + x * 3] = paw ? 30 : 90;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A known valid 1x1 lossless WebP (the sticker). */
function tinyWebp(): Buffer {
  return Buffer.from(
    'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
    'base64',
  );
}

/** A minimal valid one-page PDF with a text line (xref offsets computed). */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Ogg page CRC (poly 0x04c11db7, not reflected, init 0). */
const OGG_CRC_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let k = 0; k < 8; k += 1)
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table.push(r >>> 0);
  }
  return table;
})();

function oggPage(
  headerType: number,
  granule: number,
  serial: number,
  sequence: number,
  packets: Buffer[],
): Buffer {
  const segments = packets.map((p) => p.length);
  if (segments.some((n) => n >= 255)) throw new Error('packet too long');
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'ascii');
  head[4] = 0;
  head[5] = headerType;
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(sequence, 18);
  head[26] = segments.length;
  const page = Buffer.concat([head, Buffer.from(segments), ...packets]);
  let crc = 0;
  for (const byte of page)
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]) >>> 0;
  page.writeUInt32LE(crc, 22);
  return page;
}

/** A valid ~1 s mono Ogg/Opus voice note: OpusHead, OpusTags and 50 silent
 *  20 ms CELT frames (TOC 0xF8, 0xFF 0xFE). */
function tinyOggOpus(): Buffer {
  const serial = randomBytes(4).readUInt32LE(0);
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 'ascii');
  opusHead[8] = 1; // version
  opusHead[9] = 1; // mono
  opusHead.writeUInt16LE(312, 10); // pre-skip
  opusHead.writeUInt32LE(48_000, 12); // input rate
  opusHead.writeUInt16LE(0, 16); // gain
  opusHead[18] = 0; // channel mapping family
  const vendor = Buffer.from('houndfe-e2e', 'ascii');
  const opusTags = Buffer.alloc(8 + 4 + vendor.length + 4);
  opusTags.write('OpusTags', 0, 'ascii');
  opusTags.writeUInt32LE(vendor.length, 8);
  vendor.copy(opusTags, 12);
  opusTags.writeUInt32LE(0, 12 + vendor.length); // no user comments
  const frames = Array.from({ length: 50 }, () =>
    Buffer.from([0xf8, 0xff, 0xfe]),
  );
  return Buffer.concat([
    oggPage(0x02, 0, serial, 0, [opusHead]),
    oggPage(0x00, 0, serial, 1, [opusTags]),
    oggPage(0x04, 312 + 50 * 960, serial, 2, frames),
  ]);
}

interface SeedMedia {
  providerMediaId: string;
  mimeType: string;
  filename?: string;
  bytes: Buffer;
}

/** The sources of the seeded media: stands in for Meta's media download (the
 *  rest of the real path, MirrorMediaService → POST /media, is unchanged). */
function seedMetaDownloader(
  files: Map<string, SeedMedia>,
  tempDir: string,
  downloads: { count: number },
): MirrorMetaDownloader {
  return {
    download: ({ providerMediaId }) => {
      const file = files.get(providerMediaId);
      if (file === undefined)
        return Promise.resolve({
          kind: 'unsupported',
          reason: 'media_unavailable',
        });
      downloads.count += 1;
      const filePath = join(tempDir, `${randomUUID()}.bin`);
      writeFileSync(filePath, file.bytes, { mode: 0o600 });
      const mimeType = sniffMirrorMedia(file.bytes);
      if (mimeType === undefined)
        return Promise.resolve({
          kind: 'unsupported',
          reason: 'type_not_allowed',
        });
      return Promise.resolve({
        kind: 'ok',
        value: {
          filePath,
          mimeType,
          byteCount: file.bytes.length,
          sha256Hex: createHash('sha256').update(file.bytes).digest('hex'),
          cleanup: () => unlink(filePath),
        },
      });
    },
  };
}

type SeedKind =
  | 'text'
  | 'interactive'
  | 'image'
  | 'sticker'
  | 'document'
  | 'audio';

interface SeedLine {
  kind: SeedKind;
  text?: string;
  options?: string[];
}

const IN_TEXT = (text: string): SeedLine => ({ kind: 'text', text });
const OUT_TEXT = IN_TEXT;

/** 64 lines, strictly alternating: odd = customer (IN), even = bot (OUT). */
const SEED_SCRIPT: SeedLine[] = [
  IN_TEXT('Hola, buenas tardes'),
  OUT_TEXT('¡Hola! Bienvenido a HoundFe 🐾 ¿En qué le puedo ayudar?'),
  IN_TEXT('Quiero comprar croquetas para mi perro'),
  OUT_TEXT('Con gusto. ¿Qué edad y tamaño tiene su perrito?'),
  IN_TEXT('Es un labrador de 8 meses'),
  OUT_TEXT(
    'Perfecto, es un cachorro de raza grande. Le recomiendo una fórmula especial para cachorros grandes.',
  ),
  { kind: 'image', text: 'Así es él, se llama Max' },
  OUT_TEXT('¡Qué guapo! Max se ve muy sano 🐶'),
  IN_TEXT('¿Qué opciones tienen?'),
  {
    kind: 'interactive',
    text: 'Estas son las opciones. ¿Cuál le interesa?',
    options: ['Croquetas cachorro', 'Croquetas adulto', 'Hablar con alguien'],
  },
  IN_TEXT('Croquetas cachorro'),
  OUT_TEXT('Las tenemos en 1 kg, 4 kg, 8 kg y 15 kg.'),
  IN_TEXT('¿Cuánto cuesta la de 15 kg?'),
  OUT_TEXT('La de 15 kg cuesta $850 MXN.'),
  IN_TEXT('¿Y la de 8 kg?'),
  OUT_TEXT('La de 8 kg cuesta $480 MXN.'),
  IN_TEXT('¿Hay existencia?'),
  OUT_TEXT('Sí, hay existencia de ambas presentaciones.'),
  { kind: 'sticker' },
  OUT_TEXT('😄 ¿Le gustaría que se las enviemos a domicilio?'),
  IN_TEXT('Sí, ¿hacen envíos?'),
  OUT_TEXT(
    'Sí, enviamos a todo el país con paquetería. ¿Cuál es su código postal?',
  ),
  IN_TEXT('06700'),
  OUT_TEXT(
    'Gracias. Para esa zona el envío tiene costo; se calcula al cotizar.',
  ),
  IN_TEXT('¿Cuánto tarda en llegar?'),
  OUT_TEXT('Normalmente de 2 a 4 días hábiles.'),
  IN_TEXT('¿Puedo pagar por transferencia?'),
  OUT_TEXT('Sí, por transferencia. Le mando los datos al confirmar su pedido.'),
  { kind: 'audio' },
  OUT_TEXT(
    'Recibí su audio, pero por este medio solo puedo leer texto. ¿Me lo puede escribir, por favor?',
  ),
  IN_TEXT('Perdón, preguntaba si tienen alguna promoción'),
  OUT_TEXT(
    'Ahorita hay 10% en la segunda bolsa de la misma marca, sujeto a revisión.',
  ),
  IN_TEXT('¿Y si llevo dos de 8 kg?'),
  OUT_TEXT(
    'Dos de 8 kg serían $960 MXN antes de promoción; la reviso para confirmarle.',
  ),
  IN_TEXT('Mmm, ¿y si mejor una de 15 kg?'),
  OUT_TEXT('Una de 15 kg son $850 MXN, sale más conveniente por kilo.'),
  { kind: 'document', text: 'Le mando la receta del veterinario' },
  OUT_TEXT('Recibí el documento, gracias. Lo revisará una persona del equipo.'),
  IN_TEXT('El veterinario dice que Max es alérgico al pollo'),
  OUT_TEXT(
    'Entendido. Le paso su pregunta a una persona del equipo para confirmar los ingredientes.',
  ),
  IN_TEXT('Ok, ¿cuánto tardan en contestar?'),
  OUT_TEXT('Normalmente en menos de una hora, en horario de atención.'),
  IN_TEXT('¿Cuál es el horario?'),
  OUT_TEXT('De lunes a sábado de 9:00 a 19:00 h.'),
  IN_TEXT('Perfecto'),
  OUT_TEXT('Mientras tanto, ¿quiere que le guarde la de 15 kg en su carrito?'),
  IN_TEXT('Sí, por favor'),
  OUT_TEXT('Listo, agregué 1 croqueta cachorro de 15 kg ($850 MXN).'),
  IN_TEXT('¿Puedo agregar un juguete?'),
  OUT_TEXT('Claro, tenemos pelotas, cuerdas y mordederas. ¿Cuál prefiere?'),
  IN_TEXT('Una cuerda'),
  OUT_TEXT('Cuerda para morder, $90 MXN. Ya está en su carrito.'),
  IN_TEXT('¿Cuánto es en total?'),
  OUT_TEXT('El total es $940 MXN más el envío.'),
  IN_TEXT('¿Y cuánto sería el envío?'),
  OUT_TEXT('Lo cotizo con su código postal y le confirmo en un momento.'),
  IN_TEXT('Está bien, espero'),
  OUT_TEXT('Gracias por su paciencia 🙏'),
  IN_TEXT('¿Ya tienen respuesta de lo del pollo?'),
  OUT_TEXT(
    'Sigo esperando la confirmación del equipo; en cuanto la tenga se la comparto.',
  ),
  IN_TEXT('Ok, no hay prisa'),
  OUT_TEXT('Gracias por su comprensión.'),
  IN_TEXT('Por cierto, ¿tienen shampoo para cachorros?'),
  OUT_TEXT('Sí, tenemos shampoo hipoalergénico para cachorros. ¿Se lo agrego?'),
];

const SEED_SPAN_MS = 2 * 60 * 60 * 1000;

async function runSeedFePhase(args: Args): Promise<void> {
  const serviceKey = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (serviceKey === '') usage(`empty token file ${TOKEN_FILE}`);
  const { client, routes } = countedClient(serviceKey);

  const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const senderId = `521${args.phone}`;
  const conversationRef = conversationRefFor(senderId);
  const masked = maskConversationRef(conversationRef);
  line('config', 'ok', {
    phase: 'seed-fe',
    baseUrl: BASE_URL,
    branchId: BRANCH_ID,
    runId,
    conversation: masked,
    messages: SEED_SCRIPT.length,
  });

  /* ---- timestamps: ascending over ~2 h, ending a minute ago ---- */
  const end = Date.now() - 60_000;
  const start = end - SEED_SPAN_MS;
  const step = SEED_SPAN_MS / (SEED_SCRIPT.length - 1);
  const stampAt = (index: number): number => {
    // A deterministic wobble (never out of order: it is < half a step).
    const wobble = ((index * 7919) % 41) - 20;
    return Math.round(start + index * step + wobble * 1_000);
  };

  /* ---- 1. the open UNKNOWN_QUESTION request (real client create) ---- */
  const lastCustomerIndex = SEED_SCRIPT.length - 2; // the last IN line
  const created = await client.createHumanRequest({
    sourceRequestId: randomUUID(),
    subtype: 'UNKNOWN_QUESTION',
    customer: { phoneCountryCode: '52', phone: args.phone },
    conversationRef,
    lastCustomerMessageAt: new Date(stampAt(lastCustomerIndex)).toISOString(),
    summary:
      'Max (labrador, 8 meses) es alérgico al pollo: ¿la croqueta cachorro sirve?',
  });
  if (created.kind !== 'ok') fail('request.create', created);
  const request = created.response;
  line('request.create', 'ok', {
    status: created.status,
    outcome: request.outcome,
    requestId: request.id,
    folio: request.folio,
    requestStatus: request.status,
    mergedIntoId: request.mergedIntoId,
  });

  /* ---- 2. the real stack, with Meta media served from generated files ---- */
  const tempDir = mkdtempSync(join(tmpdir(), 'conversation-seed-fe-'));
  const files = new Map<string, SeedMedia>();
  const addFile = (file: SeedMedia) => files.set(file.providerMediaId, file);
  const mediaIdFor = (kind: SeedKind) => `e2e-seed-fe-${runId}-${kind}`;
  addFile({
    providerMediaId: mediaIdFor('image'),
    mimeType: 'image/png',
    bytes: dogPhotoPng(),
  });
  addFile({
    providerMediaId: mediaIdFor('sticker'),
    mimeType: 'image/webp',
    bytes: tinyWebp(),
  });
  addFile({
    providerMediaId: mediaIdFor('document'),
    mimeType: 'application/pdf',
    filename: 'receta-max.pdf',
    bytes: tinyPdf('Receta veterinaria de prueba - Max'),
  });
  addFile({
    providerMediaId: mediaIdFor('audio'),
    mimeType: 'audio/ogg; codecs=opus',
    bytes: tinyOggOpus(),
  });
  for (const file of files.values())
    line('media.generated', 'ok', {
      kind: file.providerMediaId.split('-').pop(),
      sniffed: sniffMirrorMedia(file.bytes),
      sizeBytes: file.bytes.length,
    });

  const downloads = { count: 0 };
  const links: MirrorLinkFetcher = {
    open: () =>
      Promise.resolve({
        kind: 'unsupported' as const,
        reason: 'media_unavailable' as const,
      }),
  };
  const { store, outbox, worker, resolved } = buildDeliveryStack({
    client,
    meta: seedMetaDownloader(files, tempDir, downloads),
    links,
    runId,
  });

  /* ---- 3. enqueue through the production enqueue + mirrorPayload ---- */
  const wamid = (n: number) => `wamid.seed-fe-${runId}-${n}`;
  const outIds: string[] = [];
  for (let index = 0; index < SEED_SCRIPT.length; index += 1) {
    const spec = SEED_SCRIPT[index];
    const n = index + 1;
    const direction = n % 2 === 1 ? 'IN' : 'OUT';
    const at = stampAt(index);
    const file = files.get(mediaIdFor(spec.kind));
    await outbox.enqueue({
      conversationRef,
      kind: 'MESSAGE_MIRROR',
      idempotencyKey: `mirror:${wamid(n)}`,
      payload: mirrorPayload(
        transcriptRow({
          senderId,
          waMessageId: wamid(n),
          direction,
          type: spec.kind,
          text: spec.text ?? null,
          media:
            file === undefined
              ? null
              : {
                  providerMediaId: file.providerMediaId,
                  mimeType: file.mimeType,
                  ...(file.filename === undefined
                    ? {}
                    : { filename: file.filename }),
                },
          details:
            spec.options === undefined ? null : { options: spec.options },
          providerTimestamp: new Date(at).toISOString(),
          observedAt: new Date(at + 500).toISOString(),
        }),
      ),
    });
    if (direction === 'OUT') outIds.push(wamid(n));
  }
  // Delivery ticks for the bot's messages (the last two stay merely delivered).
  const statusAt = (id: string, status: string) =>
    outbox.enqueue({
      conversationRef,
      kind: 'MESSAGE_STATUS',
      idempotencyKey: `status:${id}:${status}`,
      payload: {
        providerMessageId: id,
        status,
        occurredAt: new Date().toISOString(),
      },
    });
  for (const [i, id] of outIds.entries())
    await statusAt(id, i < outIds.length - 2 ? 'READ' : 'DELIVERED');
  line('enqueue', 'ok', {
    mirrorRows: SEED_SCRIPT.length,
    statusRows: outIds.length,
  });

  /* ---- 4. drain ---- */
  await drainStore(store, worker, 'drain');
  const tally = summarizeStore(store, 'rows');
  printRouteCalls(routes, 'http');

  const mediaIds = resolved
    .filter((r) => r.outcome === 'ok')
    .map((r) => r.mediaId);
  line('media', 'ids', {
    resolved: resolved.length,
    metaDownloadsServed: downloads.count,
    mediaIds,
  });

  /* ---- 5. verdict ---- */
  const problems: string[] = [];
  if (tally.DEAD > 0) problems.push('DEAD rows');
  if (tally.RETRY + tally.PENDING + tally.IN_FLIGHT > 0)
    problems.push('rows left open (RETRY/PENDING/IN_FLIGHT)');
  if (mediaIds.length !== files.size)
    problems.push('not every media file got a mediaId');
  line('summary', problems.length === 0 ? 'ok' : 'FAILED', {
    requestId: request.id,
    folio: request.folio,
    conversation: masked,
    messages: SEED_SCRIPT.length,
    mirrorCalls: callsOf(routes, MESSAGES_ROUTE),
    statusCalls: callsOf(routes, STATUSES_ROUTE),
    mediaUploads: callsOf(routes, MEDIA_ROUTE),
    mediaIds,
    problems,
  });
  if (problems.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSecureBaseUrl(BASE_URL);
  if (args.phase === 'outbox') await runOutboxPhase(args);
  else if (args.phase === 'seed-fe') await runSeedFePhase(args);
  else await runClientPhase(args);
}

main().catch((error: unknown) => {
  if (error instanceof StepFailed) line('fatal', 'error', {});
  else line('fatal', 'error', describeError(error));
  process.exitCode = 1;
});
