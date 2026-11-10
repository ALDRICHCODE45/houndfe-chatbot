import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { InMemoryBackendOutboxStore } from '../../backend-outbox/infrastructure/in-memory-backend-outbox.store';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/** S3: Meta statuses go to the backend outbox and never reach the agent. */
const CUSTOMER = '5215550001111';
const OPS = '5215500000000';

const event = (statuses: unknown[], messages?: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value:
              messages === undefined ? { statuses } : { statuses, messages },
          },
        ],
      },
    ],
  }) as unknown as WebhookEventDto;

const status = (patch: Record<string, unknown> = {}) => ({
  id: 'wamid.out-1',
  status: 'delivered',
  timestamp: '1762704132',
  recipient_id: CUSTOMER,
  ...patch,
});

function setup(
  options: { outbox?: Pick<BackendOutboxService, 'enqueue'> } = {},
) {
  const store = new InMemoryBackendOutboxStore();
  const outbox = options.outbox ?? new BackendOutboxService(store);
  const sender = {
    sendText: jest.fn(() => Promise.resolve({ providerMessageId: 'wamid.r' })),
    sendTemplate: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    tryHandle: jest.fn(() =>
      Promise.resolve({ kind: 'handled', reply: 'Hola' }),
    ),
  };
  const runner = { handle: jest.fn() };
  const dedup = {
    isDuplicate: jest.fn(() => Promise.resolve(false)),
    markSeen: jest.fn(() => Promise.resolve()),
  };
  const service = new WebhookDispatcherService(
    runner as unknown as AgentRunner,
    sender,
    dedup,
    { remember: jest.fn(), isKnown: () => false },
    {
      isOpsSender: (id: string) => id === OPS,
      resolveReply: jest.fn(),
    } as unknown as HumanHandoffService,
    {
      get: jest.fn(() => Promise.resolve(null)),
    } as unknown as ConversationStore,
    {} as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    undefined,
    undefined,
    outbox,
  );
  return { service, store, sender, agent, runner, dedup };
}

describe('WebhookDispatcherService statuses (S3)', () => {
  it('a statuses-only webhook enqueues MESSAGE_STATUS rows and never runs the agent', async () => {
    const h = setup();
    await h.service.dispatch(
      event([status({ status: 'sent' }), status({ status: 'read' })]),
    );
    expect(
      h.store
        .snapshot()
        .map(({ conversationRef, kind, idempotencyKey, payload }) => ({
          conversationRef,
          kind,
          idempotencyKey,
          payload,
        })),
    ).toEqual([
      {
        conversationRef: `wa:${CUSTOMER}`,
        kind: 'MESSAGE_STATUS',
        idempotencyKey: 'status:wamid.out-1:sent',
        payload: {
          providerMessageId: 'wamid.out-1',
          status: 'sent',
          occurredAt: '2025-11-09T16:02:12.000Z',
        },
      },
      {
        conversationRef: `wa:${CUSTOMER}`,
        kind: 'MESSAGE_STATUS',
        idempotencyKey: 'status:wamid.out-1:read',
        payload: {
          providerMessageId: 'wamid.out-1',
          status: 'read',
          occurredAt: '2025-11-09T16:02:12.000Z',
        },
      },
    ]);
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
    expect(h.agent.prepareCustomer).not.toHaveBeenCalled();
    expect(h.runner.handle).not.toHaveBeenCalled();
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.sender.sendTemplate).not.toHaveBeenCalled();
    expect(h.dedup.isDuplicate).not.toHaveBeenCalled();
  });

  it('a failed status carries the Meta error code', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        status({
          status: 'failed',
          errors: [{ code: 131047, title: 'Re-engagement message' }],
        }),
      ]),
    );
    expect(h.store.snapshot()[0]).toMatchObject({
      idempotencyKey: 'status:wamid.out-1:failed',
      payload: {
        providerMessageId: 'wamid.out-1',
        status: 'failed',
        occurredAt: '2025-11-09T16:02:12.000Z',
        errorCode: '131047',
      },
    });
    expect(h.store.snapshot()[0].payload).not.toHaveProperty('errorTitle');
  });

  it('a re-delivered status is a no-op', async () => {
    const h = setup();
    await h.service.dispatch(event([status()]));
    await h.service.dispatch(event([status(), status()]));
    expect(h.store.snapshot()).toHaveLength(1);
    expect(h.store.snapshot()[0].seq).toBe(1);
  });

  it('ignores unknown statuses with a debug log and skips the ops phone', async () => {
    const h = setup();
    const debug = jest
      .spyOn(h.service['logger'], 'debug')
      .mockImplementation(() => undefined);
    await h.service.dispatch(
      event([status({ status: 'deleted' }), status({ recipient_id: OPS })]),
    );
    expect(h.store.snapshot()).toEqual([]);
    expect(String(debug.mock.calls[0][0])).toContain('deleted');
  });

  it('an outbox failure only warns and still processes the messages', async () => {
    const enqueue = jest.fn(() => Promise.reject(new Error('db down')));
    const h = setup({ outbox: { enqueue } });
    const warn = jest
      .spyOn(h.service['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(
      h.service.dispatch(
        event(
          [status()],
          [
            {
              id: 'wamid.in-1',
              from: CUSTOMER,
              timestamp: '1762704132',
              type: 'text',
              text: { body: 'hola' },
            },
          ],
        ),
      ),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('db down');
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: CUSTOMER,
      text: 'Hola',
    });
  });

  it('without an outbox, statuses are dropped silently', async () => {
    const h = setup();
    const bare = new WebhookDispatcherService(
      h.runner as unknown as AgentRunner,
      h.sender,
      h.dedup,
      { remember: jest.fn(), isKnown: () => false },
      { isOpsSender: () => false } as unknown as HumanHandoffService,
      {} as ConversationStore,
      {} as ReceiptIngressService,
      h.agent as unknown as MinimalCatalogAgentService,
    );
    await expect(bare.dispatch(event([status()]))).resolves.toBeUndefined();
  });
});

describe('WebhookDispatcherService outbox DI (S3)', () => {
  it('injects the outbox by its class token', () => {
    const tokens = Reflect.getMetadata(
      'self:paramtypes',
      WebhookDispatcherService,
    ) as Array<{ index: number; param: unknown }>;
    expect(tokens).toContainEqual({ index: 10, param: BackendOutboxService });
  });
});
