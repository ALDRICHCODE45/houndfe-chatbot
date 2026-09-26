import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import {
  type RestockApplicationOutcomeRequest,
  type RestockIntakeInput,
} from '../chatbot-api/domain/dtos/human-decisions.dto';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { MetaWhatsappSender } from '../whatsapp/infrastructure/meta-whatsapp.sender';
import {
  RESTOCK_INTAKE_SERVICE,
  type RestockIntakeService,
} from './application/restock-intake.service';
import { bindRestockInboundEvidence } from './domain/restock-inbound-evidence';
import { PostgresRestockInboundEvidenceStore } from './infrastructure/postgres-restock-inbound-evidence.store';
import { HumanDecisionsModule } from './human-decisions.module';

// Synthetic external adapters only. All intake, scheduler, claim, ledger and
// closure operations run through the real module against this owned database.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..');
const SENDER = 'whatsapp:+5215500000001';
const PHONE = '123456789';
const BRANCH = 'synthetic-branch';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const DECISION = '33333333-3333-4333-8333-333333333333';
const PROVIDER = 'wamid.synthetic-outbound';
const TEXT =
  'Collar (SKU: COL-01): el equipo confirmó un estimado de reposición de 3 días desde su confirmación. Es un estimado, no una fecha garantizada.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          25_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function observe<T>(
  label: string,
  read: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await delay(20); // Observer-only DB polling; never drive the application poller.
  }
  throw new Error(`Timed out observing ${label}`);
}

type Reservation = {
  sender_id: string;
  route: string;
  request_key: string;
  status: string;
  intake: RestockIntakeInput;
  post_state: string;
  backend_decision_id: string;
  post_attempted_at: Date | null;
  receipt_recorded_at: Date | null;
};
type Ledger = {
  decision_id: string;
  source_request_id: string;
  attempt_id: string;
  sender_id: string;
  branch_id: string;
  row_data: Record<string, unknown>;
  ack_receipt: Record<string, unknown> | null;
};

ddescribe(
  'HumanDecisionsModule integrated RESTOCK application (owned PostgreSQL)',
  () => {
    jest.setTimeout(180_000);

    it('records intake, polls pending, accepts provider receipt, ACKs and closes', async () => {
      let container: StartedPostgreSqlContainer | undefined;
      let containerId: string | undefined;
      let appPool: Pool | undefined;
      let observer: Pool | undefined;
      let moduleRef:
        | Awaited<
            ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
          >
        | undefined;
      let closed = false;
      const pendingSeen = deferred<void>();
      const sendEntered = deferred<void>();
      const releaseSend = deferred<void>();
      const ackEntered = deferred<void>();
      const releaseAck = deferred<void>();
      let resolvedEnabled = false;
      const now = new Date();
      const createdAt = now.toISOString();
      const resolvedAt = new Date(now.getTime() - 1_000).toISOString();
      const applyBefore = new Date(now.getTime() + 3_599_000).toISOString();
      const observedAt = createdAt;
      const evidence = bindRestockInboundEvidence(
        {
          event: {
            receivingPhoneNumberId: PHONE,
            senderId: SENDER,
            messageId: 'wamid.synthetic-inbound',
          },
          providerTimestampSeconds: String(Math.floor(now.getTime() / 1_000)),
          observedAt,
        },
        PHONE,
      );
      expect(evidence).not.toBeNull();
      if (!evidence) throw new Error('Synthetic inbound evidence invalid');
      const intake: RestockIntakeInput = {
        type: 'RESTOCK',
        sourceRequestId: evidence.sourceRequestId,
        productId: PRODUCT,
        productName: 'Collar',
        variantId: null,
        sku: 'COL-01',
        requestedQuantity: 2,
        observedStockAtRequest: 0,
        stockObservedAt: createdAt,
        supersedesDecisionId: null,
      };
      const snapshot = {
        branchId: BRANCH,
        branchName: null,
        productId: PRODUCT,
        productName: 'Collar',
        variantId: null,
        sku: 'COL-01',
        requestedQuantity: 2,
        observedStockAtRequest: 0,
        stockObservedAt: createdAt,
      };
      const receipt = {
        id: DECISION,
        sourceRequestId: evidence.sourceRequestId,
        type: 'RESTOCK' as const,
        status: 'PENDING' as const,
        version: 1 as const,
        createdAt,
        snapshot,
        supersedesDecisionId: null,
        resolution: null,
        applyBefore: null,
      };
      const resolved = {
        ...receipt,
        status: 'RESOLVED' as const,
        version: 2 as const,
        resolution: {
          action: 'PROVIDE_RESTOCK_ESTIMATE' as const,
          restockDays: 3,
          resolvedAt,
        },
        applyBefore,
      };
      const submit = jest.fn(async () => receipt);
      const getDecision = jest.fn(async () => {
        if (!resolvedEnabled) {
          // Choose the immutable PENDING response before signalling the test.
          const chosen = receipt;
          pendingSeen.resolve();
          return chosen;
        }
        return resolved;
      });
      const sendText = jest.fn(async () => {
        sendEntered.resolve();
        await releaseSend.promise;
        return { providerMessageId: PROVIDER };
      });
      const recordOutcome = jest.fn(
        async (_id: string, request: RestockApplicationOutcomeRequest) => {
          void _id;
          ackEntered.resolve();
          await releaseAck.promise;
          return {
            id: DECISION,
            version: 2 as const,
            attemptId: request.attemptId,
            outcome: request.outcome,
            ackReceivedAt: new Date().toISOString(),
          };
        },
      );
      const options = (uri: string) => ({
        connectionString: uri,
        max: 2,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        statement_timeout: 12_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 20_000,
      });
      const reservationRows = async () =>
        (
          await observer!.query<Reservation>(
            'SELECT * FROM human_decision_reservations',
          )
        ).rows;
      const ledgerRows = async () =>
        (
          await observer!.query<Ledger>(
            'SELECT * FROM restock_application_ledger',
          )
        ).rows;
      try {
        container = await new PostgreSqlContainer('postgres:16-alpine').start();
        containerId = container.getId();
        // No inherited environment, CLI URI, shared database or migration down.
        execFileSync(
          process.execPath,
          [
            join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
            '--config-file',
            'package.json',
            '--config-value',
            'pg-migrate',
            'up',
            '2600000000000',
            '--timestamp',
          ],
          {
            cwd: ROOT,
            env: { DATABASE_URL: container.getConnectionUri() },
            stdio: 'pipe',
            timeout: 60_000,
          },
        );
        appPool = new Pool(options(container.getConnectionUri()));
        observer = new Pool(options(container.getConnectionUri()));
        const poolEnd = jest.spyOn(appPool, 'end'); // Call through: Nest owns the pool.
        expect(
          await new PostgresRestockInboundEvidenceStore(observer).record(
            evidence,
          ),
        ).toEqual({ action: 'recorded', evidence });
        await observer.query(
          'INSERT INTO conversation_state (sender_id, last_message_at, data) VALUES ($1, $2, $3)',
          [SENDER, createdAt, JSON.stringify({ messages: [] })],
        );
        expect(await reservationRows()).toHaveLength(0);
        expect(await ledgerRows()).toHaveLength(0);
        const config: Record<string, unknown> = {
          'humanDecisions.restockEnabled': true,
          'chatbotApi.branchId': BRANCH,
          'meta.phoneNumberId': PHONE,
        };
        moduleRef = await Test.createTestingModule({
          imports: [DatabaseModule, HumanDecisionsModule],
        })
          .overrideProvider(ConfigService)
          .useValue({ get: (key: string) => config[key] })
          .overrideProvider(PG_POOL)
          .useValue(appPool)
          .overrideProvider(ChatbotApiHttpClient)
          .useValue({})
          .overrideProvider(CHATBOT_API_CLIENT)
          .useValue({
            submitRestockIntake: submit,
            getRestockDecision: getDecision,
            recordRestockApplicationOutcome: recordOutcome,
          })
          .overrideProvider(MetaWhatsappSender)
          .useValue({})
          .overrideProvider(WHATSAPP_SENDER)
          .useValue({ sendText })
          .compile();
        await moduleRef.init();
        const service = moduleRef.get<RestockIntakeService>(
          RESTOCK_INTAKE_SERVICE,
        );
        expect(await service.coordinate({ senderId: SENDER, intake })).toEqual({
          decision: 'recorded',
          historicalPollId: DECISION,
        });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledWith(intake);
        expect(await reservationRows()).toEqual([
          expect.objectContaining({
            sender_id: SENDER,
            route: 'RESTOCK',
            request_key: evidence.sourceRequestId,
            status: 'ACTIVE',
            intake,
            post_state: 'RECEIPT_RECORDED',
            backend_decision_id: DECISION,
          }),
        ]);
        const reservation = (await reservationRows())[0];
        expect(reservation.post_attempted_at).toBeInstanceOf(Date);
        expect(reservation.receipt_recorded_at).toBeInstanceOf(Date);
        await bounded(pendingSeen.promise, 'automatic pending GET');
        expect(getDecision).toHaveBeenCalledTimes(1);
        expect(getDecision).toHaveBeenCalledWith(DECISION);
        expect(sendText).not.toHaveBeenCalled();
        expect(recordOutcome).not.toHaveBeenCalled();
        expect(await ledgerRows()).toHaveLength(0);
        resolvedEnabled = true;

        await bounded(
          sendEntered.promise,
          'automatic resolved GET and SEND_STARTED',
        );
        expect(getDecision).toHaveBeenCalledTimes(2);
        expect(getDecision).toHaveBeenNthCalledWith(2, DECISION);
        expect(sendText).toHaveBeenCalledTimes(1);
        expect(sendText).toHaveBeenCalledWith({ to: SENDER, text: TEXT });
        const started = await observe('committed SEND_STARTED', async () => {
          const rows = await ledgerRows();
          return rows.length === 1 && rows[0].row_data.state === 'SEND_STARTED'
            ? rows[0]
            : null;
        });
        expect(started).toEqual(
          expect.objectContaining({
            decision_id: DECISION,
            source_request_id: evidence.sourceRequestId,
            sender_id: SENDER,
            branch_id: BRANCH,
            ack_receipt: null,
            row_data: started.row_data,
          }),
        );
        expect(started.row_data).toMatchObject({
          state: 'SEND_STARTED',
          senderId: SENDER,
          branchId: BRANCH,
          sourceRequestId: evidence.sourceRequestId,
          decisionId: DECISION,
          resolutionVersion: 2,
          resolvedAt,
          applyBefore,
          attemptId: started.attempt_id,
        });
        expect(started.row_data.sendToken).toMatch(/^[0-9a-f-]{36}$/i);
        expect(started.row_data.attemptedAt).toEqual(
          expect.stringMatching(/^\d{4}-/),
        );
        expect(started.attempt_id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(started.row_data.sendToken).not.toBe(started.attempt_id);
        expect(recordOutcome).not.toHaveBeenCalled();
        expect((await reservationRows())[0].status).toBe('ACTIVE');

        releaseSend.resolve();
        await bounded(ackEntered.promise, 'outcome ACK request');
        const accepted = await observe(
          'durable PROVIDER_ACCEPTED',
          async () => {
            const rows = await ledgerRows();
            return rows.length === 1 &&
              rows[0].row_data.state === 'PROVIDER_ACCEPTED'
              ? rows[0]
              : null;
          },
        );
        expect(accepted.ack_receipt).toBeNull();
        expect(accepted.row_data).toEqual({
          ...started.row_data,
          state: 'PROVIDER_ACCEPTED',
          providerMessageId: PROVIDER,
          providerAcceptedObservedAt:
            accepted.row_data.providerAcceptedObservedAt,
        });
        expect(accepted.row_data.providerAcceptedObservedAt).toEqual(
          expect.stringMatching(/^\d{4}-/),
        );
        expect((await reservationRows())[0].status).toBe('ACTIVE');
        expect(recordOutcome).toHaveBeenCalledTimes(1);
        expect(recordOutcome).toHaveBeenCalledWith(DECISION, {
          attemptId: started.attempt_id,
          expectedResolutionVersion: 2,
          outcome: 'PROVIDER_ACCEPTED',
          attemptedAt: started.row_data.attemptedAt,
          providerMessageId: PROVIDER,
          providerAcceptedObservedAt:
            accepted.row_data.providerAcceptedObservedAt,
        });
        releaseAck.resolve();
        const closedRow = await observe(
          'persisted ACK and CLOSED reservation',
          async () => {
            const [rows, reservations] = await Promise.all([
              ledgerRows(),
              reservationRows(),
            ]);
            return rows.length === 1 &&
              rows[0].ack_receipt !== null &&
              reservations.length === 1 &&
              reservations[0].status === 'CLOSED'
              ? rows[0]
              : null;
          },
        );
        expect(closedRow.ack_receipt).toEqual({
          id: DECISION,
          version: 2,
          attemptId: started.attempt_id,
          outcome: 'PROVIDER_ACCEPTED',
          ackReceivedAt: closedRow.ack_receipt?.ackReceivedAt,
        });
        expect(closedRow.ack_receipt?.ackReceivedAt).toEqual(
          expect.stringMatching(/^\d{4}-/),
        );
        expect(closedRow.row_data).toEqual(accepted.row_data);
        expect(await ledgerRows()).toHaveLength(1);
        expect(await reservationRows()).toEqual([
          expect.objectContaining({
            sender_id: SENDER,
            request_key: evidence.sourceRequestId,
            backend_decision_id: DECISION,
            status: 'CLOSED',
            intake,
          }),
        ]);
        expect(sendText).toHaveBeenCalledTimes(1);
        expect(recordOutcome).toHaveBeenCalledTimes(1);
        expect(
          (await observer.query('SELECT * FROM restock_inbound_evidence')).rows,
        ).toEqual([
          expect.objectContaining({
            source_request_id: evidence.sourceRequestId,
            sender_id: SENDER,
            message_id: evidence.messageId,
            receiving_phone_number_id: PHONE,
          }),
        ]);
        expect(
          (await observer.query('SELECT data FROM conversation_state')).rows,
        ).toEqual([{ data: { messages: [] } }]);
        await moduleRef.close();
        closed = true;
        expect(poolEnd).toHaveBeenCalledTimes(1);
        expect((await reservationRows())[0].status).toBe('CLOSED');
      } finally {
        // Release even on a failed assertion: Nest shutdown must drain in-flight work.
        releaseSend.resolve();
        releaseAck.resolve();
        try {
          if (moduleRef && !closed) {
            await moduleRef.close();
            closed = true;
          } else if (appPool && !moduleRef) {
            await appPool.end();
          }
        } finally {
          try {
            await observer?.end();
          } finally {
            if (container) {
              await container.stop();
              process.stderr.write(
                `[module-db] stopped owned container ${containerId}\n`,
              );
            }
          }
        }
      }
    });
  },
);
