import type { HumanHandoffService } from '../../../human-handoff/application/human-handoff.service';
import {
  type HumanHandoffCreateResult,
  type HumanHandoffResolveReplyResult,
} from '../../../human-handoff/application/human-handoff.service';
import { makeRequestHumanAssistanceTool } from './request-human-assistance.tool';

/**
 * Contract tests for the 12th sale-flow tool `requestHumanAssistance`.
 *
 * Spec scenarios (sale-flow-tools §"`requestHumanAssistance` is the twelfth sale-flow tool"):
 *   - happy path: tool calls humanHandoffService.create with the
 *     senderId from context + the input kind + digest.
 *   - idempotent re-call returns the existing envelope (service owns this).
 *   - inputSchema rejects malformed digests.
 *   - inputSchema rejects the reserved `shipping_approval` kind (no
 *     discriminator match — R6 slice lifts the gate).
 */
describe('makeRequestHumanAssistanceTool', () => {
  const baseDeps = {
    cashierUserId: '00000000-0000-4000-8000-000000000001',
  };

  function buildHandoffServiceMock() {
    const create = jest.fn(
      async (): Promise<HumanHandoffCreateResult> => ({
        ok: true,
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        customerNotified: true,
      }),
    );
    const resolveReply = jest.fn(
      async (): Promise<HumanHandoffResolveReplyResult> => ({
        kind: 'no_pending',
        reply: 'noop',
      }),
    );
    const isOpsSender = jest.fn().mockReturnValue(false);
    const svc = {
      create,
      resolveReply,
      isOpsSender,
    } as unknown as HumanHandoffService;
    return { svc, create };
  }

  it('happy path: tool calls humanHandoffService.create with senderId from context + kind + digest', async () => {
    const { svc, create } = buildHandoffServiceMock();
    const deps = {
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    };
    const tool = makeRequestHumanAssistanceTool(deps);

    const result = await tool.execute(
      {
        kind: 'out_of_stock',
        digest: {
          productId: '00000000-0000-4000-8000-000000000001',
          name: 'Croquetas',
          quantity: 2,
        },
      },
      {
        toolCallId: 't',
        messages: [],
        context: { senderId: 'S' },
      },
    );

    expect(create).toHaveBeenCalledWith({
      senderId: 'S',
      kind: 'out_of_stock',
      digest: {
        kind: 'out_of_stock',
        productId: '00000000-0000-4000-8000-000000000001',
        name: 'Croquetas',
        quantity: 2,
      },
    });
    expect(result).toEqual({
      ok: true,
      requestId: 'abc123def456',
      ref: 'HF-abc123def456',
      customerNotified: true,
    });
  });

  it('inputSchema rejects a malformed digest (non-UUID productId)', () => {
    const { svc } = buildHandoffServiceMock();
    const deps = {
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    };
    const tool = makeRequestHumanAssistanceTool(deps);

    const r = tool.inputSchema.safeParse({
      kind: 'out_of_stock',
      digest: { productId: 'not-a-uuid', name: 'X' },
    });
    expect(r.success).toBe(false);
  });

  it('inputSchema rejects the reserved shipping_approval kind', () => {
    const { svc } = buildHandoffServiceMock();
    const deps = {
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    };
    const tool = makeRequestHumanAssistanceTool(deps);

    const r = tool.inputSchema.safeParse({
      kind: 'shipping_approval',
      digest: { productId: 'p', name: 'X' },
    });
    expect(r.success).toBe(false);
  });

  it('idempotent re-call: service returns existing envelope; tool delegates', async () => {
    const create = jest.fn(
      async (): Promise<HumanHandoffCreateResult> => ({
        ok: true,
        requestId: 'existing00',
        ref: 'HF-existing00',
        customerNotified: true,
      }),
    );
    const svc = {
      create,
      resolveReply: jest.fn(),
      isOpsSender: jest.fn(),
    } as unknown as HumanHandoffService;
    const deps = {
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    };
    const tool = makeRequestHumanAssistanceTool(deps);

    const result = await tool.execute(
      {
        kind: 'needs_human_review',
        digest: {
          items: [
            {
              productId: '00000000-0000-4000-8000-000000000001',
              quantity: 1,
              unitPriceCents: 100,
            },
          ],
          originalTotalCents: 100,
        },
      },
      {
        toolCallId: 't',
        messages: [],
        context: { senderId: 'S' },
      },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      requestId: 'existing00',
      ref: 'HF-existing00',
      customerNotified: true,
    });
  });

  it('inputSchema accepts an expiration_date digest', () => {
    const { svc } = buildHandoffServiceMock();
    const deps = {
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    };
    const tool = makeRequestHumanAssistanceTool(deps);

    const r = tool.inputSchema.safeParse({
      kind: 'expiration_date',
      digest: {
        productId: '00000000-0000-4000-8000-000000000001',
        name: 'Croquetas',
        question: '¿cuál es la fecha de caducidad?',
      },
    });
    expect(r.success).toBe(true);
  });

  it('contextSchema declares { senderId: string }', () => {
    const { svc } = buildHandoffServiceMock();
    const deps = {
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    };
    const tool = makeRequestHumanAssistanceTool(deps);
    expect(tool.contextSchema).toBeDefined();
    const r = tool.contextSchema!.safeParse({ senderId: '5215550001111' });
    expect(r.success).toBe(true);
  });
});
