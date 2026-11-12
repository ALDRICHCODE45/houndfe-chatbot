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
 * scripts/e2e/README.md. */
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

const BASE_URL = process.env.CHATBOT_API_BASE_URL ?? 'http://localhost:3003';
const BRANCH_ID =
  process.env.CHATBOT_API_BRANCH_ID ?? 'ced6cc10-a037-4f41-92af-ee69bbb51c8b';
const TOKEN_FILE = '/tmp/houndfe-dev-bot-token.txt';

interface Args {
  phone: string;
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: conversation-mirror-e2e [--phone 5550004444]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phone: '5550004444' };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSecureBaseUrl(BASE_URL);
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

main().catch((error: unknown) => {
  if (error instanceof StepFailed) line('fatal', 'error', {});
  else line('fatal', 'error', describeError(error));
  process.exitCode = 1;
});
