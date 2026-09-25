import { makeUpdateDeliveryTool as makeUpdateDeliveryToolRaw } from './update-delivery.tool';
import type { ToolDeps } from '../tool-deps';
import { asSchemaVerifiedTool } from '../../../../test/fixtures/sale-flow-tool-schema';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../../human-handoff/application/human-handoff.service';

/**
 * Inert human-handoff dependency for the signal-only `updateDelivery` tool.
 *
 * `updateDelivery` never calls the handoff service (ADR-27: only
 * `requestHumanAssistance` does), yet `ToolDeps` requires the dependency. The
 * service is a nominal NestJS provider with private injected fields, so no
 * structural literal can satisfy it directly. Typing the stub as the exact
 * `Pick` this suite relies on keeps the single `as unknown as
 * HumanHandoffService` bridge documented here instead of an empty `as never`
 * cast.
 */
function inertHumanHandoffService(): HumanHandoffService {
  const stub: Pick<
    HumanHandoffService,
    'create' | 'resolveReply' | 'isOpsSender'
  > = {
    create: jest.fn<
      ReturnType<HumanHandoffService['create']>,
      Parameters<HumanHandoffService['create']>
    >(),
    resolveReply: jest.fn<
      ReturnType<HumanHandoffService['resolveReply']>,
      Parameters<HumanHandoffService['resolveReply']>
    >(),
    isOpsSender: jest.fn<boolean, [string]>(),
  };
  return stub as unknown as HumanHandoffService;
}

/**
 * Local deps factory: injects the inert handoff stub and exposes the tool
 * through the verified schema boundary so `inputSchema` is the concrete Zod
 * schema the assertions exercise.
 */
const makeUpdateDeliveryTool = (deps: Omit<ToolDeps, 'humanHandoffService'>) =>
  asSchemaVerifiedTool(
    makeUpdateDeliveryToolRaw({
      ...deps,
      humanHandoffService: inertHumanHandoffService(),
    }),
  );

/**
 * Unit tests for the updateDelivery tool factory.
 *
 * Spec scenarios:
 *   - Maps saleId + carrierName? + trackingRef? + estimatedDeliveryAt? to
 *     chatbotApi.updateDelivery
 *   - Registered only; not exercised end-to-end by the slice's flow
 *   - Catches UpstreamError into a retryable upstream envelope
 */
describe('makeUpdateDeliveryTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-4000-9000-0000-000000000001',
  };

  it('forwards saleId + optional fields to chatbotApi.updateDelivery', async () => {
    const updateDelivery = jest.fn().mockResolvedValue(undefined);
    const deps = {
      ...baseDeps,
      chatbotApi: { updateDelivery } as unknown as ChatbotApiClient,
    };
    const tool = makeUpdateDeliveryTool(deps);

    const result = await tool.execute(
      {
        saleId: '00000000-4000-9000-0000-000000000001',
        carrierName: 'DHL',
        trackingRef: 'TRACK-1',
        estimatedDeliveryAt: '2026-07-01T12:00:00Z',
      },
      { toolCallId: 't', messages: [], context: {} },
    );
    expect(updateDelivery).toHaveBeenCalledWith(
      '00000000-4000-9000-0000-000000000001',
      {
        carrierName: 'DHL',
        trackingRef: 'TRACK-1',
        estimatedDeliveryAt: '2026-07-01T12:00:00Z',
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts an empty patch (only saleId)', async () => {
    const updateDelivery = jest.fn().mockResolvedValue(undefined);
    const deps = {
      ...baseDeps,
      chatbotApi: { updateDelivery } as unknown as ChatbotApiClient,
    };
    const tool = makeUpdateDeliveryTool(deps);

    await tool.execute(
      {
        saleId: '00000000-4000-9000-0000-000000000001',
      },
      { toolCallId: 't', messages: [], context: {} },
    );
    expect(updateDelivery).toHaveBeenCalledWith(
      '00000000-4000-9000-0000-000000000001',
      expect.objectContaining({}),
    );
  });

  it('rejects a non-UUID saleId at the schema layer', () => {
    const tool = makeUpdateDeliveryTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ saleId: 'x' });
    expect(r.success).toBe(false);
  });

  it('catches UpstreamError(503) into a retryable upstream envelope', async () => {
    const updateDelivery = jest
      .fn()
      .mockRejectedValue(new UpstreamError('x', 503));
    const deps = {
      ...baseDeps,
      chatbotApi: { updateDelivery } as unknown as ChatbotApiClient,
    };
    const tool = makeUpdateDeliveryTool(deps);

    await expect(
      tool.execute(
        { saleId: '00000000-4000-9000-0000-000000000001' },
        { toolCallId: 't', messages: [], context: {} },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
