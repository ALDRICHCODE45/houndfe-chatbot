/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { makeGetPaymentDetailsTool } from './get-payment-details.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../../chatbot-api/domain/errors';
import type { PaymentDetail } from '../../../chatbot-api/domain/dtos/payment-details.dto';

/**
 * Unit tests for the 10th AI-SDK tool factory `getPaymentDetails` (Q1 / R11).
 *
 * Spec scenarios:
 *   - 200 returns the PaymentDetail projection (id, bankName, beneficiary,
 *     clabe, accountNumber, isActive, updatedAt).
 *   - 404 NO_ACTIVE_PAYMENT_DETAIL → {ok:false, error:{kind:'noActivePaymentDetail', retryable:false}}.
 *   - inputSchema accepts {} and rejects {extra:'x'} (Zod, NOT passthrough).
 *   - chatbotApi.getPaymentDetails() called exactly once with no arguments.
 *   - Non-ChatbotApiError rethrows (BranchMismatchError etc.).
 */
describe('makeGetPaymentDetailsTool', () => {
  const baseDeps = {
    store: {} as never,
    cashierUserId: '00000000-4000-9000-0000-000000000001',
  };

  const sample: PaymentDetail = {
    id: 'p-1',
    bankName: 'AFIRME',
    beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV',
    clabe: '012345678901234567',
    accountNumber: '1234567890',
    isActive: true,
    updatedAt: '2026-08-24T12:00:00.000Z',
  };

  it('exposes description + Zod inputSchema + execute', () => {
    const tool = makeGetPaymentDetailsTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('200 returns the PaymentDetail projection and calls getPaymentDetails once with no args', async () => {
    const getPaymentDetails = jest.fn().mockResolvedValue(sample);
    const deps = {
      ...baseDeps,
      chatbotApi: { getPaymentDetails } as unknown as ChatbotApiClient,
    };
    const tool = makeGetPaymentDetailsTool(deps);
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(getPaymentDetails).toHaveBeenCalledTimes(1);
    expect(getPaymentDetails).toHaveBeenCalledWith();
    expect(result).toEqual({ ok: true, paymentDetail: sample });
  });

  it('404 NO_ACTIVE_PAYMENT_DETAIL → {noActivePaymentDetail, retryable:false} and does NOT propagate', async () => {
    const err = new ChatbotApiError(
      'no active payment detail',
      404,
      {
        statusCode: 404,
        error: 'NO_ACTIVE_PAYMENT_DETAIL',
        message: 'No active payment detail configured',
      },
      'NO_ACTIVE_PAYMENT_DETAIL',
    );
    const getPaymentDetails = jest.fn().mockRejectedValue(err);
    const deps = {
      ...baseDeps,
      chatbotApi: { getPaymentDetails } as unknown as ChatbotApiClient,
    };
    const tool = makeGetPaymentDetailsTool(deps);
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'noActivePaymentDetail', retryable: false },
    });
  });

  it('inputSchema accepts an empty object {}', () => {
    const tool = makeGetPaymentDetailsTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('inputSchema rejects an object with extra keys (NOT passthrough)', () => {
    const tool = makeGetPaymentDetailsTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ extra: 'x' });
    expect(r.success).toBe(false);
  });

  it('non-ChatbotApiError (e.g. BranchMismatchError) rethrows', async () => {
    class BranchMismatchError extends Error {}
    const getPaymentDetails = jest
      .fn()
      .mockRejectedValue(new BranchMismatchError('branch-mismatch'));
    const deps = {
      ...baseDeps,
      chatbotApi: { getPaymentDetails } as unknown as ChatbotApiClient,
    };
    const tool = makeGetPaymentDetailsTool(deps);
    await expect(
      tool.execute({}, { toolCallId: 't', messages: [], context: undefined }),
    ).rejects.toBeInstanceOf(BranchMismatchError);
  });

  it('UpstreamError (5xx with errorCode) → {upstream, retryable:true}', async () => {
    const err = new UpstreamError('boom', 503, { error: 'BOOM' }, 'BOOM');
    const getPaymentDetails = jest.fn().mockRejectedValue(err);
    const deps = {
      ...baseDeps,
      chatbotApi: { getPaymentDetails } as unknown as ChatbotApiClient,
    };
    const tool = makeGetPaymentDetailsTool(deps);
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
