/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { makeUpsertCustomerTool } from './upsert-customer.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { CustomerUpsertResponse } from '../../../chatbot-api/domain/dtos/customers.dto';

/**
 * Unit tests for the upsertCustomer tool factory.
 *
 * Spec scenarios:
 *   - Forwards the full DTO to chatbotApi.upsertCustomer
 *   - Validates address.street is non-empty (AGENTS.md §4.4.5)
 *   - Validates firstName 1..100, phoneCountryCode 1..10, phone 1..20
 *   - Validates optional preferredPaymentMethod max 50
 *   - Catches UpstreamError into a retryable upstream envelope
 */
describe('makeUpsertCustomerTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-0000-4000-8000-000000000001',
    humanHandoffService: {} as never,
  };

  it('forwards the full DTO to chatbotApi.upsertCustomer', async () => {
    const upsertResponse: CustomerUpsertResponse = {
      status: 'created',
      customer: {
        customerId: '00000000-0000-4000-8000-000000000099',
        firstName: 'Ada',
        lastName: null,
        phoneCountryCode: '+52',
        phone: '5550001111',
        preferredPaymentMethod: null,
        address: null,
      },
    };
    const upsertCustomer = jest.fn().mockResolvedValue(upsertResponse);
    const deps = {
      ...baseDeps,
      chatbotApi: { upsertCustomer } as unknown as ChatbotApiClient,
    };
    const tool = makeUpsertCustomerTool(deps);

    const dto = {
      firstName: 'Ada',
      phoneCountryCode: '+52',
      phone: '5550001111',
      address: { street: 'Calle 1' },
    };
    const result = await tool.execute(dto, {
      toolCallId: 't',
      messages: [],
      context: undefined,
    });
    expect(upsertCustomer).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ ok: true, ...upsertResponse });
  });

  it('rejects an empty firstName at the schema layer (AGENTS.md §4.4.5 @MaxLength(100) required)', () => {
    const tool = makeUpsertCustomerTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      firstName: '',
      phoneCountryCode: '+52',
      phone: '5550001111',
      address: { street: 'Calle 1' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a missing address.street at the schema layer (AGENTS.md §4.4.5)', () => {
    const tool = makeUpsertCustomerTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      firstName: 'Ada',
      phoneCountryCode: '+52',
      phone: '5550001111',
      address: {},
    });
    expect(r.success).toBe(false);
  });

  it('rejects phoneCountryCode longer than 10 chars', () => {
    const tool = makeUpsertCustomerTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      firstName: 'Ada',
      phoneCountryCode: '+12345678901',
      phone: '5550001111',
      address: { street: 'Calle 1' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects phone longer than 20 chars', () => {
    const tool = makeUpsertCustomerTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      firstName: 'Ada',
      phoneCountryCode: '+52',
      phone: '1'.repeat(21),
      address: { street: 'Calle 1' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects preferredPaymentMethod longer than 50 chars', () => {
    const tool = makeUpsertCustomerTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      firstName: 'Ada',
      phoneCountryCode: '+52',
      phone: '5550001111',
      preferredPaymentMethod: 'x'.repeat(51),
      address: { street: 'Calle 1' },
    });
    expect(r.success).toBe(false);
  });

  it('catches UpstreamError(500) into a retryable upstream envelope', async () => {
    const upsertCustomer = jest
      .fn()
      .mockRejectedValue(new UpstreamError('x', 500));
    const deps = {
      ...baseDeps,
      chatbotApi: { upsertCustomer } as unknown as ChatbotApiClient,
    };
    const tool = makeUpsertCustomerTool(deps);

    await expect(
      tool.execute(
        {
          firstName: 'Ada',
          phoneCountryCode: '+52',
          phone: '5550001111',
          address: { street: 'Calle 1' },
        },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
