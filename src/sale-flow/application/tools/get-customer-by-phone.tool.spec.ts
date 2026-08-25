/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { makeGetCustomerByPhoneTool } from './get-customer-by-phone.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { CustomerLookupResponse } from '../../../chatbot-api/domain/dtos/customers.dto';

/**
 * Unit tests for the getCustomerByPhone tool factory.
 *
 * Spec scenarios:
 *   - Maps phoneCountryCode + phone to chatbotApi.getCustomerByPhone
 *   - Returns { ok: true, ...CustomerLookupResponse } on success
 *   - Rejects empty / over-long phoneCountryCode or phone at the schema layer
 *   - Catches thrown UpstreamError into a retryable upstream envelope
 */
describe('makeGetCustomerByPhoneTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-0000-4000-8000-000000000001',
  };

  it('forwards phoneCountryCode + phone to chatbotApi.getCustomerByPhone', async () => {
    const lookup: CustomerLookupResponse = {
      found: false,
      customer: null,
    };
    const getCustomerByPhone = jest.fn().mockResolvedValue(lookup);
    const deps = {
      ...baseDeps,
      chatbotApi: { getCustomerByPhone } as unknown as ChatbotApiClient,
    };
    const tool = makeGetCustomerByPhoneTool(deps);

    const result = await tool.execute(
      { phoneCountryCode: '+52', phone: '5550001111' },
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(getCustomerByPhone).toHaveBeenCalledWith('+52', '5550001111');
    expect(result).toEqual({ ok: true, ...lookup });
  });

  it('rejects empty phoneCountryCode at the schema layer (AGENTS.md §4.4.4)', () => {
    const tool = makeGetCustomerByPhoneTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ phoneCountryCode: '', phone: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects phoneCountryCode longer than 10 chars at the schema layer (AGENTS.md §4.4.4)', () => {
    const tool = makeGetCustomerByPhoneTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      phoneCountryCode: '+12345678901',
      phone: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects phone longer than 20 chars at the schema layer (AGENTS.md §4.4.4)', () => {
    const tool = makeGetCustomerByPhoneTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      phoneCountryCode: '+52',
      phone: '1'.repeat(21),
    });
    expect(r.success).toBe(false);
  });

  it('catches UpstreamError(503) into a retryable upstream envelope', async () => {
    const getCustomerByPhone = jest
      .fn()
      .mockRejectedValue(new UpstreamError('x', 503));
    const deps = {
      ...baseDeps,
      chatbotApi: { getCustomerByPhone } as unknown as ChatbotApiClient,
    };
    const tool = makeGetCustomerByPhoneTool(deps);

    await expect(
      tool.execute(
        { phoneCountryCode: '+52', phone: '5550001111' },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
