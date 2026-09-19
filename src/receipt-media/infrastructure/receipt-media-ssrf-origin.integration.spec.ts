import { execSync } from 'node:child_process';
import type { LookupAddress } from 'node:dns';
import type { Agent } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { AxiosRequestConfig } from 'axios';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { CapabilityService } from '../application/capability.service';
import { ReceiptIngestionProcessor } from '../application/receipt-ingestion.processor';
import { ReceiptProcessingDispatcher } from '../application/receipt-processing-dispatcher.service';
import type { ReceiptAttachmentService } from '../application/receipt-attachment.service';
import type {
  ObjectStoragePort,
  PutObjectInput,
} from '../domain/object-storage.port';
import {
  MetaMediaClient,
  type MetaHttp,
  type MetaHttpResponse,
} from './meta-media.client';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import { ReceiptMediaIngestionWorker } from './receipt-media-ingestion.worker';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const BASE = 'https://graph.facebook.com/v23.0';
const GRAPH = 'graph.facebook.com';
const LOOKASIDE = 'lookaside.fbsbx.com';
const HOSTILE = 'https://attacker.example/steal';
const HOSTILE_HOST = 'attacker.example';
const TOKEN = 'bearer.ssrf.7b2a';
const SALE = 'cccccccc-0001-4000-8000-000000000001';
const RETRY = { minMs: 1_000, maxMs: 1_250, toleranceMs: 500 };
const PUBLIC: LookupAddress[] = [{ address: '8.8.8.8', family: 4 }];
const PRIVATE: LookupAddress[] = [{ address: '10.0.0.5', family: 4 }];
const METADATA_OK: MetaHttpResponse = {
  status: 200,
  data: {
    url: `https://${LOOKASIDE}/dl`,
    mime_type: 'image/jpeg',
    file_size: 4096,
  },
};
const METADATA_HOSTILE: MetaHttpResponse = {
  status: 200,
  data: { url: HOSTILE, mime_type: 'image/jpeg', file_size: 4096 },
};
const REDIRECT_HOSTILE: MetaHttpResponse = {
  status: 302,
  data: null,
  headers: { location: HOSTILE },
};
const media = (n: number, label: string) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.odd7b2a.${label}`,
  mediaId: `media.odd7b2a.${label}`,
  sender: `sender.odd7b2a.${label}`,
  objectKey: `receipts/aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
});
type Media = ReturnType<typeof media>;
const REBIND = media(1, 'rebind');
const BAD_DOWNLOAD = media(2, 'download');
const BAD_REDIRECT = media(3, 'redirect');
const EXHAUST = media(4, 'exhaust');
const COLS = (
  'id webhook_message_id provider_media_id sender_id captured_sale_id' +
  ' object_key status version declared_mime_type declared_amount_cents' +
  ' lease_owner lease_expires_at'
).split(' ');
const INSERT = `INSERT INTO receipt_media (${COLS.join(
  ', ',
)}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')})`;

ddescribe('receipt-media SSRF origin rejection (ODD-7B2a)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;
  let priorDatabaseUrl: string | undefined;
  const workers = new Set<ReceiptMediaIngestionWorker>();
  const attach = jest.fn();
  const attachment = { attach } as unknown as Pick<
    ReceiptAttachmentService,
    'attach'
  >;
  const putCalls: PutObjectInput[] = [];
  const storage: Pick<ObjectStoragePort, 'put'> = {
    put: (input) => {
      putCalls.push(input);
      input.content.resume();
      return Promise.resolve({ etag: 'etag.ssrf', versionId: null });
    },
  };

  const harness = (options: {
    graph?: LookupAddress[];
    metadata?: MetaHttpResponse;
  }) => {
    const requests: AxiosRequestConfig[] = [];
    const createAgent = jest.fn<Agent, [LookupFunction]>(
      () => ({ destroy: jest.fn() }) as unknown as Agent,
    );
    const createTempFile = jest.fn(() =>
      Promise.reject(new Error('ODD-7B2a: temp-file tripwire reached')),
    );
    const resolve = jest.fn((hostname: string) => {
      if (hostname === GRAPH) return Promise.resolve(options.graph ?? PUBLIC);
      if (hostname === LOOKASIDE) return Promise.resolve(PUBLIC);
      return Promise.reject(new Error('ODD-7B2a: hostile host resolution'));
    });
    const http: MetaHttp = (config) => {
      requests.push(config);
      const hostname = new URL(config.url as string).hostname;
      if (hostname === GRAPH)
        return Promise.resolve(options.metadata ?? METADATA_OK);
      if (hostname === LOOKASIDE) return Promise.resolve(REDIRECT_HOSTILE);
      return Promise.reject(new Error('ODD-7B2a: disallowed hop'));
    };
    const client = new MetaMediaClient(
      {
        graphApiBaseUrl: BASE,
        allowedHosts: [GRAPH, LOOKASIDE],
        metadataTimeoutMs: 5000,
        downloadTimeoutMs: 20000,
      },
      () => TOKEN,
      { http, resolve, createAgent, createTempFile },
    );
    return { client, requests, resolve, createTempFile };
  };
  const boot = (owner: string, client: MetaMediaClient) => {
    const capability = new CapabilityService(
      new Map([['1', Buffer.alloc(32, 3)]]),
      '1',
    );
    const dispatcher = new ReceiptProcessingDispatcher(
      new ReceiptIngestionProcessor(client, storage, store, capability),
      attachment,
    );
    const worker = new ReceiptMediaIngestionWorker(store, dispatcher, {
      owner,
      pollIntervalMs: 50,
      batchSize: 4,
      maxConcurrency: 4,
    });
    workers.add(worker);
    worker.onApplicationBootstrap();
    return worker;
  };
  const seed = async (target: Media): Promise<void> => {
    const row: Row = {
      status: 'RESERVED',
      version: '0',
      declared_mime_type: 'image/jpeg',
      id: target.id,
      webhook_message_id: target.wamid,
      provider_media_id: target.mediaId,
      sender_id: target.sender,
      captured_sale_id: SALE,
      object_key: target.objectKey,
    };
    await pool.query(
      INSERT,
      COLS.map((column) => row[column] ?? null),
    );
  };
  const readRow = async (id: string): Promise<Row> =>
    (await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [id]))
      .rows[0];
  const readOutbox = async (): Promise<Row[]> =>
    (await pool.query<Row>('SELECT * FROM receipt_media_outbox')).rows;
  const waitFor = async <T>(
    probe: () => Promise<T | null>,
    ms = 40_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('ODD-7B2a: waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const waitAttemptOne = (target: Media): Promise<Row> =>
    waitFor(async () => {
      const row = await readRow(target.id);
      return row.meta_attempts === 1 &&
        row.last_error_code === 'NETWORK_FAILURE' &&
        row.lease_owner === null
        ? row
        : null;
    });
  const assertNoAcceptedEvidence = (row: Row) => {
    const fields = (
      'downloaded_at response_mime_type detected_mime_type byte_count ' +
      'content_sha256 stored_at object_etag object_version_id ' +
      'capability_token_hash capability_key_version ' +
      'capability_key_version_text capability_issued_at capability_revoked_at'
    ).split(' ');
    for (const field of fields) expect(row[field]).toBeNull();
  };
  const assertCleanup = (
    h: ReturnType<typeof harness>,
    expectedResolveHosts: string[],
  ) => {
    const hosts = h.requests.map((r) => new URL(r.url as string).hostname);
    expect(hosts).not.toContain(HOSTILE_HOST);
    for (const request of h.requests)
      expect(request.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(h.resolve.mock.calls.map(([host]) => host)).toEqual(
      expectedResolveHosts,
    );
    expect(h.createTempFile).not.toHaveBeenCalled();
    expect(putCalls).toHaveLength(0);
    expect(attach).not.toHaveBeenCalled();
  };
  const assertAttemptOne = (row: Row, startedAt: number) => {
    expect(row).toMatchObject({
      status: 'RESERVED',
      version: '3',
      meta_attempts: 1,
      last_error_category: 'META_TRANSPORT',
      last_error_code: 'NETWORK_FAILURE',
      lease_owner: null,
      lease_expires_at: null,
    });
    assertNoAcceptedEvidence(row);
    const observedAt = Date.now();
    const nextAttemptAt = (row.next_attempt_at as Date).getTime();
    expect(nextAttemptAt).toBeGreaterThan(observedAt);
    expect(nextAttemptAt).toBeGreaterThanOrEqual(
      startedAt + RETRY.minMs - RETRY.toleranceMs,
    );
    expect(nextAttemptAt).toBeLessThanOrEqual(
      observedAt + RETRY.maxMs + RETRY.toleranceMs,
    );
  };

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    store = new PostgresReceiptMediaStore(pool);
  });
  afterAll(async () => {
    try {
      for (const worker of workers) await worker.onModuleDestroy();
    } finally {
      workers.clear();
      try {
        if (pool) await pool.end();
      } finally {
        try {
          if (container) await container.stop();
        } finally {
          if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = priorDatabaseUrl;
        }
      }
    }
  });
  afterEach(async () => {
    try {
      await Promise.all([...workers].map((worker) => worker.onModuleDestroy()));
      expect(attach).not.toHaveBeenCalled();
    } finally {
      workers.clear();
      attach.mockClear();
      putCalls.length = 0;
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox,' +
          ' receipt_media',
      );
    }
  });

  it('rejects a metadata origin that resolves to a private address with zero permitted HTTP hops', async () => {
    await seed(REBIND);
    const h = harness({ graph: PRIVATE });
    const startedAt = Date.now();
    boot('ssrf.rebind', h.client);
    const row = await waitAttemptOne(REBIND);
    assertAttemptOne(row, startedAt);
    assertCleanup(h, [GRAPH]);
    expect(h.requests).toHaveLength(0);
    expect(await readOutbox()).toEqual([]);
    expect(await store.claimBatch(10, 'ssrf.probe')).toEqual([]);
  });

  it('rejects a disallowed download origin after exactly one permitted metadata hop', async () => {
    await seed(BAD_DOWNLOAD);
    const h = harness({ metadata: METADATA_HOSTILE });
    const startedAt = Date.now();
    boot('ssrf.download', h.client);
    const row = await waitAttemptOne(BAD_DOWNLOAD);
    assertAttemptOne(row, startedAt);
    assertCleanup(h, [GRAPH]);
    expect(h.requests.map((r) => new URL(r.url as string).hostname)).toEqual([
      GRAPH,
    ]);
    expect(await readOutbox()).toEqual([]);
    expect(await store.claimBatch(10, 'ssrf.probe')).toEqual([]);
  });

  it('rejects a hostile redirect origin after exactly metadata plus download hops', async () => {
    await seed(BAD_REDIRECT);
    const h = harness({});
    const startedAt = Date.now();
    boot('ssrf.redirect', h.client);
    const row = await waitAttemptOne(BAD_REDIRECT);
    assertAttemptOne(row, startedAt);
    assertCleanup(h, [GRAPH, LOOKASIDE]);
    expect(h.requests.map((r) => new URL(r.url as string).hostname)).toEqual([
      GRAPH,
      LOOKASIDE,
    ]);
    expect(await readOutbox()).toEqual([]);
    expect(await store.claimBatch(10, 'ssrf.probe')).toEqual([]);
  });

  it('naturally exhausts three logical attempts into META_EXHAUSTED_PRE_STORAGE with one intent', async () => {
    await seed(EXHAUST);
    const h = harness({});
    boot('ssrf.exhaust', h.client);
    const failed = await waitFor(async () => {
      const row = await readRow(EXHAUST.id);
      return row.status === 'FAILED' ? row : null;
    });
    expect(failed).toMatchObject({
      failure_stage: 'META_EXHAUSTED_PRE_STORAGE',
      meta_attempts: 3,
      last_error_category: 'META_TRANSPORT',
      last_error_code: 'NETWORK_FAILURE',
      version: '9',
    });
    assertNoAcceptedEvidence(failed);
    expect(h.requests.map((r) => new URL(r.url as string).hostname)).toEqual([
      GRAPH,
      LOOKASIDE,
      GRAPH,
      LOOKASIDE,
      GRAPH,
      LOOKASIDE,
    ]);
    assertCleanup(h, [GRAPH, LOOKASIDE, GRAPH, LOOKASIDE, GRAPH, LOOKASIDE]);
    const terminalVersion = failed.version as string;
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template_key: 'RECEIPT_UNAVAILABLE_LATER',
      receipt_media_id: EXHAUST.id,
      recipient_id: EXHAUST.sender,
      source_webhook_message_id: EXHAUST.wamid,
      receipt_state_version: terminalVersion,
      dedupe_key: `receipt-unavailable-later:${EXHAUST.id}:${terminalVersion}:${EXHAUST.wamid}`,
    });
    expect(intents[0].template_args).toEqual({});
    expect(await store.claimBatch(10, 'ssrf.probe')).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.requests).toHaveLength(6);
    expect(await readOutbox()).toHaveLength(1);
  });
});
