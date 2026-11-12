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
 * `runOutboxPhase`. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const BASE_URL = process.env.CHATBOT_API_BASE_URL ?? 'http://localhost:3003';
const BRANCH_ID =
  process.env.CHATBOT_API_BRANCH_ID ?? 'ced6cc10-a037-4f41-92af-ee69bbb51c8b';
const TOKEN_FILE = '/tmp/houndfe-dev-bot-token.txt';

type Phase = 'client' | 'outbox';

interface Args {
  phase: Phase;
  phone: string;
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: conversation-mirror-e2e [--phase client|outbox] [--phone 5550004444]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: 'client', phone: '5550004444' };
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
    } else if (flag === '--phase') {
      if (value !== 'client' && value !== 'outbox')
        usage('--phase must be client or outbox');
      args.phase = value;
    } else usage(`unknown argument ${flag}`);
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
  const store = new InMemoryBackendOutboxStore();
  const outbox = new BackendOutboxService(store);
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
  const mediaService = new MirrorMediaService({
    client,
    meta,
    links,
    cache: new InMemoryMirrorMediaCacheStore(),
  });
  const resolved: Array<{ outcome: string; mediaId?: string; from?: string }> =
    [];
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
  const drain = async (label: string): Promise<number> => {
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
  };
  const started = Date.now();
  await drain('drain');
  const elapsedMs = Date.now() - started;

  const summarizeRows = (label: string) => {
    const rows = store.snapshot();
    const tally = {
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
  };
  const printCalls = (label: string) => {
    for (const [route, stats] of [...routes.entries()].sort()) {
      line(label, 'http', {
        route,
        calls: stats.requests,
        statuses: Object.fromEntries(stats.statuses),
      });
    }
  };

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSecureBaseUrl(BASE_URL);
  if (args.phase === 'outbox') await runOutboxPhase(args);
  else await runClientPhase(args);
}

main().catch((error: unknown) => {
  if (error instanceof StepFailed) line('fatal', 'error', {});
  else line('fatal', 'error', describeError(error));
  process.exitCode = 1;
});
