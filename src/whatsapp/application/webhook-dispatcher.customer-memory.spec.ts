import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import {
  WebhookDispatcherService,
  normalizeInboundMessages,
} from './webhook-dispatcher.service';

/**
 * S1: the WhatsApp contact profile name reaches the agent as `profileName`
 * (it survives the whitelisting validation pipe), and the stored profile is
 * warmed before any reply so fixed replies use the stored style.
 */
const SENDER = '5215550001111';

const event = (contacts: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts,
              messages: [
                {
                  id: 'wamid.in',
                  from: SENDER,
                  timestamp: '1719000000',
                  type: 'text',
                  text: { body: 'hola' },
                },
              ],
            },
          },
        ],
      },
    ],
  }) as WebhookEventDto;

describe('S1 contact profile name', () => {
  it('normalizes the sender contact profile name', () => {
    const [message] = normalizeInboundMessages(
      event([{ wa_id: SENDER, profile: { name: 'Ana Pérez' } }]),
    );
    expect(message.profileName).toBe('Ana Pérez');
  });

  it('ignores another contact, a missing or a blank name', () => {
    for (const contacts of [
      [{ wa_id: '5215550009999', profile: { name: 'Otro' } }],
      [{ wa_id: SENDER }],
      [{ wa_id: SENDER, profile: { name: '   ' } }],
      [{ wa_id: SENDER, profile: { name: 42 } }],
    ])
      expect(
        normalizeInboundMessages(event(contacts))[0].profileName,
      ).toBeUndefined();
  });

  it('keeps profile.name through the whitelisting DTO validation', () => {
    const dto = plainToInstance(
      WebhookEventDto,
      event([{ wa_id: SENDER, profile: { name: 'Ana' }, extra: 'x' }]),
    );
    expect(
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }),
    ).toEqual([]);
    expect(dto.entry?.[0].changes?.[0].value?.contacts?.[0]).toEqual(
      expect.objectContaining({ wa_id: SENDER, profile: { name: 'Ana' } }),
    );
    expect(normalizeInboundMessages(dto)[0].profileName).toBe('Ana');
  });
});

describe('S1 dispatcher wiring', () => {
  function setup(agent: Record<string, unknown>) {
    const sender = {
      sendText: jest.fn(async () => ({ providerMessageId: 'wamid.out' })),
      sendTemplate: jest.fn(),
    };
    const service = new WebhookDispatcherService(
      {} as AgentRunner,
      sender,
      {
        claim: jest.fn(async () => 'claim-token'),
        release: jest.fn(async () => undefined),
        purgeBefore: jest.fn(async () => 0),
        markSeen: jest.fn(async () => undefined),
      },
      { remember: jest.fn(), isKnown: () => false },
      { isOpsSender: () => false } as unknown as HumanHandoffService,
      { get: jest.fn(async () => null) } as unknown as ConversationStore,
      {} as ReceiptIngressService,
      agent as unknown as MinimalCatalogAgentService,
    );
    return { service, sender };
  }

  it('warms the profile, then passes profileName to the agent', async () => {
    const order: string[] = [];
    const agent = {
      prepareCustomer: jest.fn(async () => {
        order.push('prepare');
      }),
      tryHandle: jest.fn(async () => {
        order.push('turn');
        return { kind: 'handled', reply: 'Hola' };
      }),
    };
    const h = setup(agent);
    await h.service.dispatch(
      event([{ wa_id: SENDER, profile: { name: 'Ana' } }]),
    );
    expect(order).toEqual(['prepare', 'turn']);
    expect(agent.prepareCustomer).toHaveBeenCalledWith(SENDER);
    expect(agent.tryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: SENDER, profileName: 'Ana' }),
    );
  });

  it('a failing warm-up never blocks the turn', async () => {
    const agent = {
      prepareCustomer: jest.fn(async () => {
        throw new Error('db down');
      }),
      tryHandle: jest.fn(async () => ({ kind: 'handled', reply: 'Hola' })),
    };
    const h = setup(agent);
    await h.service.dispatch(event([]));
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Hola',
    });
    const [args] = agent.tryHandle.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(args).not.toHaveProperty('profileName');
  });
});
