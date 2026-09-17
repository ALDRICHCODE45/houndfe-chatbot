import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type {
  ConversationStore,
  ConversationState,
} from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { ReceiptAmountRouterService } from '../../receipt-media/application/receipt-amount-router.service';
import {
  ReceiptIngressService,
  type ReceiptIngressStore,
} from '../../receipt-media/application/receipt-ingress.service';
import type {
  ReservationOutcome,
  ReserveInput,
} from '../../receipt-media/domain/receipt-media-store.port';
import { PostgresReceiptMediaStore } from '../../receipt-media/infrastructure/postgres-receipt-media.store';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { PostgresWebhookDedupStore } from '../infrastructure/postgres-webhook-dedup.store';
import { SignatureGuard } from './signature.guard';
import { WebhookController } from './webhook.controller';

/**
 * ODD-1C integrated admission evidence (RM1, RM3, WA2).
 *
 * Real Meta signature guard + real controller + real WebhookDispatcherService
 * + real ReceiptIngressService + real PostgresReceiptMediaStore + real
 * PostgresWebhookDedupStore over one Testcontainers PostgreSQL instance with
 * the production migrations applied. Only unrelated collaborators (agent
 * runner, sender, amount router, conversation store, handoff, recent-outbound
 * echo window) are stubs, so every assertion is about the real admission
 * lifecycle. Gated by RUN_DOCKER_TESTS=1 like the other Testcontainers suites.
 *
 * No production source, worker composition, STORED claim, or external call is
 * exercised: admission leaves the row in RESERVED with no lease.
 */

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'verify-token';
const PLACED_SALE_ID = '4f7c2f9e-1f30-4a2b-8c3d-0f1e2d3c4b5a';
const FORCED_FAILURE_WAMID = 'wamid.forced-marker-failure';

type Identity = { wamid: string; mediaId: string; senderId: string };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

type Deferred = ReturnType<typeof deferred>;

/**
 * Transparent instrumentation over the real store. `admit()` resolves only
 * after the real transaction has committed; the gate can hold that resolved
 * admission open so a test can inspect PostgreSQL before the HTTP response.
 */
class AdmissionProbe implements ReceiptIngressStore {
  private gate: { admitted: Deferred; release: Deferred } | null = null;

  constructor(private readonly store: ReceiptIngressStore) {}

  holdNextAdmission(): { admitted: Promise<void>; release: () => void } {
    const admitted = deferred();
    const release = deferred();
    this.gate = { admitted, release };
    return { admitted: admitted.promise, release: () => release.resolve() };
  }

  async admit(input: ReserveInput): Promise<ReservationOutcome> {
    const outcome = await this.store.admit(input);
    const gate = this.gate;
    if (gate === null) return outcome;
    this.gate = null;
    gate.admitted.resolve();
    await gate.release.promise;
    return outcome;
  }
}

interface Harness {
  app: INestApplication;
  probe: AdmissionProbe;
  dedup: PostgresWebhookDedupStore;
  sender: { sendText: jest.Mock };
  conversations: { get: jest.Mock; getState: jest.Mock };
  agentRunner: { handle: jest.Mock };
  amountRouter: { route: jest.Mock };
  handoff: { isOpsSender: jest.Mock; resolveReply: jest.Mock };
  close: () => Promise<void>;
}

ddescribe('Webhook receipt admission integration (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let seq = 0;
  const harnesses: Harness[] = [];

  const configValues: Record<string, string> = {
    'meta.appSecret': APP_SECRET,
    'meta.verifyToken': VERIFY_TOKEN,
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const identity = (label: string): Identity => {
    seq += 1;
    return {
      wamid: `wamid.${label}.${seq}`,
      mediaId: `media.${label}.${seq}`,
      senderId: `sender.${label}.${seq}`,
    };
  };

  const mediaBody = (o: Identity): string => {
    const message = {
      id: o.wamid,
      from: o.senderId,
      timestamp: '1719000000',
      type: 'image',
      image: { id: o.mediaId, mime_type: 'image/jpeg' },
    };
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [message] } }] }],
    });
  };

  const sign = (body: string): string =>
    `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

  const postSigned = (app: INestApplication, body: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body);

  const counts = async (): Promise<{ receipts: number; markers: number }> => {
    const { rows } = await pool.query<{ receipts: number; markers: number }>(
      `SELECT (SELECT count(*)::int FROM receipt_media) AS receipts,
              (SELECT count(*)::int FROM processed_webhook_messages) AS markers`,
    );
    return rows[0];
  };

  const dropForcedFailureTrigger = async (): Promise<void> => {
    await pool.query(
      'DROP TRIGGER IF EXISTS forced_marker_failure ON processed_webhook_messages',
    );
    await pool.query('DROP FUNCTION IF EXISTS forced_marker_failure()');
  };

  const buildHarness = async (): Promise<Harness> => {
    const probe = new AdmissionProbe(new PostgresReceiptMediaStore(pool));
    const dedup = new PostgresWebhookDedupStore(pool);
    const state = {
      data: { placedSaleId: PLACED_SALE_ID },
    } as ConversationState;
    const conversations = {
      get: jest.fn<Promise<ConversationState | null>, [string]>(() =>
        Promise.resolve(state),
      ),
      getState: jest.fn<Promise<ConversationState | null>, [string]>(() =>
        Promise.resolve(state),
      ),
    };
    const sender = { sendText: jest.fn() };
    const agentRunner = { handle: jest.fn() };
    const amountRouter = { route: jest.fn() };
    const handoff = {
      isOpsSender: jest.fn(() => false),
      resolveReply: jest.fn(),
    };
    const recentOutbound = {
      isKnown: jest.fn(() => false),
      remember: jest.fn(),
    };

    const dispatcher = new WebhookDispatcherService(
      agentRunner as unknown as AgentRunner,
      sender,
      dedup,
      recentOutbound,
      handoff as unknown as HumanHandoffService,
      conversations as unknown as ConversationStore,
      amountRouter as unknown as ReceiptAmountRouterService,
      new ReceiptIngressService(
        { enabled: true },
        { getState: conversations.getState },
        probe,
      ),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        SignatureGuard,
        { provide: ConfigService, useValue: configService },
        { provide: WebhookDispatcherService, useValue: dispatcher },
      ],
    }).compile();

    const app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
    };
    const harness: Harness = {
      app,
      probe,
      dedup,
      sender,
      conversations,
      agentRunner,
      amountRouter,
      handoff,
      close,
    };
    harnesses.push(harness);
    return harness;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.close()));
    await dropForcedFailureTrigger();
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox,' +
        ' receipt_media, processed_webhook_messages',
    );
  });

  it('holds the signed POST until the real atomic admission has committed', async () => {
    const { wamid, mediaId, senderId } = identity('commit');
    const body = mediaBody({ wamid, mediaId, senderId });
    const h = await buildHarness();

    const gate = h.probe.holdNextAdmission();
    let settled = false;
    const pending = postSigned(h.app, body)
      .expect(200)
      .expect({ received: true })
      .then(() => (settled = true));
    const observedPending = pending.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    try {
      const first = await Promise.race([
        gate.admitted.then(() => ({ kind: 'admitted' as const })),
        observedPending,
      ]);
      if (first.kind === 'rejected') throw first.error;
      expect(first.kind).toBe('admitted');

      // Pre-response proof point: the real transaction already committed, so
      // both durable artifacts are visible while the HTTP response is open.
      expect(settled).toBe(false);
      expect(await counts()).toEqual({ receipts: 1, markers: 1 });

      const receipt = await pool.query<{
        status: string;
        webhook_message_id: string;
        lease_owner: string | null;
      }>('SELECT status, webhook_message_id, lease_owner FROM receipt_media');
      expect(receipt.rows).toEqual([
        { status: 'RESERVED', webhook_message_id: wamid, lease_owner: null },
      ]);
      expect(h.sender.sendText).not.toHaveBeenCalled();

      gate.release();
      await pending;
      expect(settled).toBe(true);
      expect(await counts()).toEqual({ receipts: 1, markers: 1 });
    } finally {
      gate.release();
      await observedPending;
    }
  });

  it('converges two concurrent signed deliveries on one receipt and one marker', async () => {
    const { wamid, mediaId, senderId } = identity('concurrent');
    const body = mediaBody({ wamid, mediaId, senderId });
    const h = await buildHarness();

    await Promise.all([
      postSigned(h.app, body).expect(200).expect({ received: true }),
      postSigned(h.app, body).expect(200).expect({ received: true }),
    ]);

    expect(await counts()).toEqual({ receipts: 1, markers: 1 });
    const markers = await pool.query<{ message_id: string }>(
      'SELECT message_id FROM processed_webhook_messages',
    );
    expect(markers.rows).toEqual([{ message_id: wamid }]);
    expect(h.sender.sendText).not.toHaveBeenCalled();
  });

  it('returns 500 with zero durable rows when the marker insert fails inside admission', async () => {
    const body = mediaBody({
      wamid: FORCED_FAILURE_WAMID,
      mediaId: 'media.forced.1',
      senderId: 'sender.forced.1',
    });
    const h = await buildHarness();

    // Static, parameter-free DDL: this trigger rejects every marker insert
    // for the duration of the test, so the failure is injected inside the
    // real admission transaction rather than in any pre-check.
    await pool.query(
      `CREATE FUNCTION forced_marker_failure() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION 'forced marker-insert failure';
         END;
       $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      'CREATE TRIGGER forced_marker_failure BEFORE INSERT ON processed_webhook_messages' +
        ' FOR EACH ROW EXECUTE FUNCTION forced_marker_failure()',
    );

    await postSigned(h.app, body).expect(500);
    expect(await counts()).toEqual({ receipts: 0, markers: 0 });
    expect(h.sender.sendText).not.toHaveBeenCalled();

    // Triangulation: with the injected fault removed the same signed body
    // admits normally, proving the 500 came from the forced DB failure.
    await dropForcedFailureTrigger();
    await postSigned(h.app, body).expect(200).expect({ received: true });
    expect(await counts()).toEqual({ receipts: 1, markers: 1 });
  });

  it('replays a signed body after app and adapter recreation without reprocessing', async () => {
    const { wamid, mediaId, senderId } = identity('replay');
    const body = mediaBody({ wamid, mediaId, senderId });

    const first = await buildHarness();
    await postSigned(first.app, body).expect(200).expect({ received: true });
    expect(await counts()).toEqual({ receipts: 1, markers: 1 });
    await first.close();

    const replayed = await buildHarness();
    await postSigned(replayed.app, body).expect(200).expect({ received: true });

    expect(await counts()).toEqual({ receipts: 1, markers: 1 });
    expect(replayed.conversations.get).not.toHaveBeenCalled();
    expect(replayed.conversations.getState).not.toHaveBeenCalled();
    expect(replayed.sender.sendText).not.toHaveBeenCalled();
    expect(replayed.agentRunner.handle).not.toHaveBeenCalled();
    expect(replayed.amountRouter.route).not.toHaveBeenCalled();
    expect(replayed.handoff.resolveReply).not.toHaveBeenCalled();
  });
});
