import { Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import * as preflight from '../../../human-decisions/application/restock-request-preflight';
import type { HumanHandoffService } from '../../../human-handoff/application/human-handoff.service';
import {
  type HumanHandoffCreateResult,
  type HumanHandoffResolveReplyResult,
} from '../../../human-handoff/application/human-handoff.service';
import { deriveRestockSourceRequestId } from '../../../human-decisions/domain/restock-source-identity';
import { makeRequestHumanAssistanceTool } from './request-human-assistance.tool';

type SafeParseSchema = {
  safeParse(input: unknown): { success: boolean };
};

type SchemaToolView = {
  inputSchema: SafeParseSchema;
  contextSchema?: SafeParseSchema;
};

const schemaToolView = (tool: object): SchemaToolView =>
  tool as unknown as SchemaToolView;

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
    const schemas = schemaToolView(tool);

    const r = schemas.inputSchema.safeParse({
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
    const schemas = schemaToolView(tool);

    const r = schemas.inputSchema.safeParse({
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
    const schemas = schemaToolView(tool);

    const r = schemas.inputSchema.safeParse({
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
    const schemas = schemaToolView(tool);
    expect(schemas.contextSchema).toBeDefined();
    const r = schemas.contextSchema!.safeParse({ senderId: '5215550001111' });
    expect(r.success).toBe(true);
  });

  it('contextSchema accepts and preserves an optional three-field inboundEvent', () => {
    const { svc } = buildHandoffServiceMock();
    const tool = makeRequestHumanAssistanceTool({
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    });
    const schemas = schemaToolView(tool);
    const event = {
      receivingPhoneNumberId: '123456789012345',
      senderId: 'S',
      messageId: 'wamid.ABC123',
    };
    const parsed = schemas.contextSchema!.safeParse({
      senderId: 'S',
      inboundEvent: event,
    }) as { success: boolean; data?: { inboundEvent?: unknown } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.inboundEvent).toEqual(event);
    const legacy = schemas.contextSchema!.safeParse({ senderId: 'S' });
    expect(legacy.success).toBe(true);
  });

  it('contextSchema rejects an extra key or a blank inboundEvent field', () => {
    const { svc } = buildHandoffServiceMock();
    const tool = makeRequestHumanAssistanceTool({
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    });
    const schemas = schemaToolView(tool);
    const base = {
      receivingPhoneNumberId: '1',
      senderId: 'S',
      messageId: 'm',
    };
    expect(
      schemas.contextSchema!.safeParse({
        senderId: 'S',
        inboundEvent: { ...base, extra: 'x' },
      }).success,
    ).toBe(false);
    expect(
      schemas.contextSchema!.safeParse({
        senderId: 'S',
        inboundEvent: { ...base, receivingPhoneNumberId: '' },
      }).success,
    ).toBe(false);
  });

  it('execute ignores an inboundEvent in context and keeps the legacy create call', async () => {
    const { svc, create } = buildHandoffServiceMock();
    const tool = makeRequestHumanAssistanceTool({
      ...baseDeps,
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: svc,
    });
    const context = {
      senderId: 'S',
      inboundEvent: {
        receivingPhoneNumberId: '1',
        senderId: 'S',
        messageId: 'm',
      },
    };
    const result = await tool.execute(
      {
        kind: 'out_of_stock',
        digest: {
          productId: '00000000-0000-4000-8000-000000000001',
          name: 'Croquetas',
        },
      },
      { toolCallId: 't', messages: [], context },
    );
    expect(create).toHaveBeenCalledWith({
      senderId: 'S',
      kind: 'out_of_stock',
      digest: {
        kind: 'out_of_stock',
        productId: '00000000-0000-4000-8000-000000000001',
        name: 'Croquetas',
      },
    });
    expect(result).toEqual({
      ok: true,
      requestId: 'abc123def456',
      ref: 'HF-abc123def456',
      customerNotified: true,
    });
  });

  describe('RESTOCK routing behind the exact default-off gate', () => {
    const SENDER = '5215550001111';
    const PRODUCT_ID = '00000000-0000-4000-8000-000000000001';
    const INBOUND = {
      receivingPhoneNumberId: '123456789012345',
      senderId: SENDER,
      messageId: 'wamid.ABC123',
    };
    const outOfStockInput = {
      kind: 'out_of_stock' as const,
      digest: { productId: PRODUCT_ID, name: 'Croquetas' },
    };
    const failClosed = {
      ok: false,
      error: { kind: 'restock_unavailable', retryable: false },
    };

    const buildStock = () => ({
      productId: PRODUCT_ID,
      name: 'Croquetas',
      stock: { status: 'out_of_stock' as const, quantity: 0 },
      variants: [],
    });

    function buildRestockDeps(
      overrides: {
        markers?: { readForSender: jest.Mock };
        coordinator?: { coordinate: jest.Mock };
        getStock?: jest.Mock;
        getState?: jest.Mock;
      } = {},
    ) {
      const markers = overrides.markers ?? {
        readForSender: jest.fn(async () => ({
          legacyRequestPending: false,
          restockIntentPresent: false,
        })),
      };
      const coordinator: { coordinate: jest.Mock } = overrides.coordinator ?? {
        coordinate: jest.fn(async () => ({
          decision: 'recorded' as const,
          historicalPollId: 'BACKEND-POLL-ID-1',
        })),
      };
      const getStock = overrides.getStock ?? jest.fn(async () => buildStock());
      const getState = overrides.getState ?? jest.fn(async () => null);
      const create = jest.fn(
        async (): Promise<HumanHandoffCreateResult> => ({
          ok: true,
          requestId: 'abc123def456',
          ref: 'HF-abc123def456',
          customerNotified: true,
        }),
      );
      const deps = {
        cashierUserId: '00000000-0000-4000-8000-000000000001',
        chatbotApi: { getStock } as never,
        store: { get: getState } as never,
        humanHandoffService: { create } as never,
        restock: {
          enabled: true as const,
          markers: markers as never,
          coordinator: coordinator as never,
        },
      };
      return { deps, markers, coordinator, create, getStock, getState };
    }

    describe('fixed server-only diagnostics', () => {
      const success = {
        ok: true,
        outcome: 'historical_intake_recorded',
        customerNotified: false,
      };
      const attemptId = '10000000-0000-4000-8000-000000000001';
      let log: jest.SpyInstance;
      let uuid: jest.SpyInstance;
      const run = (deps: ReturnType<typeof buildRestockDeps>['deps']) =>
        makeRequestHumanAssistanceTool(deps).execute(outOfStockInput, {
          toolCallId: 'PRIVATE-SDK-ID',
          messages: [],
          context: { senderId: SENDER, inboundEvent: INBOUND },
        });
      const expectLog = (stage: string, outcome: string, reason = 'none') => {
        expect(log.mock.calls).toEqual([
          [
            `restock_diagnostic attemptId=${attemptId} stage=${stage} outcome=${outcome} reason=${reason}`,
          ],
        ]);
      };
      beforeEach(() => {
        log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        uuid = jest.spyOn(crypto, 'randomUUID').mockReturnValue(attemptId);
      });
      afterEach(() => jest.restoreAllMocks());

      it.each([
        'identity_unbound',
        'marker_read_failed',
        'invalid_digest',
        'catalog_read_failed',
        'catalog_unverified',
        'existing_legacy',
        'existing_restock',
        'conflicting_markers',
        'indeterminate_marker_state',
        'route_not_available',
      ])('observes preflight blocked %s', async (reason) => {
        jest.spyOn(preflight, 'preflightRestockRequest').mockResolvedValue({
          route: 'blocked',
          reason,
        } as never);
        const { deps, coordinator, create } = buildRestockDeps();
        expect(await run(deps)).toEqual(failClosed);
        expectLog('preflight', 'blocked', reason);
        expect(coordinator.coordinate).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      });

      it.each([
        ['recorded', 'none'],
        ['existing', 'none'],
        ['hold', 'post_in_flight'],
        ['hold', 'unknown_hold'],
        ['hold', 'record_unconfirmed'],
        ['blocked', 'malformed_input'],
        ['blocked', 'occupied'],
        ['blocked', 'collision'],
        ['blocked', 'reservation_blocked'],
      ])('observes %s/%s in order', async (decision, reason) => {
        const { deps, coordinator, markers, getState, getStock, create } =
          buildRestockDeps();
        coordinator.coordinate.mockResolvedValue({ decision, reason });
        expect(await run(deps)).toEqual(
          ['recorded', 'existing'].includes(decision) ? success : failClosed,
        );
        expectLog('coordinator', decision, reason);
        const calls = [
          markers.readForSender,
          getState,
          getStock,
          coordinator.coordinate,
        ];
        calls.forEach((call) => expect(call).toHaveBeenCalledTimes(1));
        const order = calls.map((call) => call.mock.invocationCallOrder[0]);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(create).not.toHaveBeenCalled();
      });

      it.each(['preflight', 'coordinator'])(
        'sanitizes an unexpected %s exception',
        async (stage) => {
          const { deps, coordinator } = buildRestockDeps();
          const error = new Error('PRIVATE-error-stack-headers');
          if (stage === 'preflight') {
            jest
              .spyOn(preflight, 'preflightRestockRequest')
              .mockRejectedValue(error);
          } else {
            coordinator.coordinate.mockRejectedValue(error);
          }
          expect(await run(deps)).toEqual(failClosed);
          expectLog(stage, 'exception', 'exception');
          expect(coordinator.coordinate).toHaveBeenCalledTimes(
            stage === 'preflight' ? 0 : 1,
          );
        },
      );

      it.each(['preflight', 'coordinator'])(
        'bounds hostile %s metadata without serialization',
        async (stage) => {
          const { deps, coordinator } = buildRestockDeps();
          const poison = jest.fn(() => {
            throw new Error('PRIVATE-getter');
          });
          for (const reason of [
            'PRIVATE-reason',
            'occupied',
            null,
            { toString: poison },
            undefined,
          ]) {
            log.mockClear();
            const outcome = Object.defineProperties(
              { route: 'blocked', decision: 'hold', reason },
              {
                historicalPollId: { get: poison },
                digest: { get: poison },
                headers: { get: poison },
                toJSON: { get: poison },
              },
            );
            if (reason === undefined) {
              Object.defineProperty(outcome, 'reason', { get: poison });
            }
            if (stage === 'preflight') {
              jest
                .spyOn(preflight, 'preflightRestockRequest')
                .mockResolvedValue(outcome as never);
            } else {
              coordinator.coordinate.mockResolvedValue(outcome);
            }
            expect(await run(deps)).toEqual(failClosed);
            expectLog(
              stage,
              stage === 'preflight' ? 'blocked' : 'hold',
              'unknown',
            );
          }
          expect(poison).not.toHaveBeenCalled();
        },
      );

      it.each(['legacy', 'PRIVATE-route'])('bounds route %s', async (route) => {
        jest
          .spyOn(preflight, 'preflightRestockRequest')
          .mockResolvedValue({ route } as never);
        const { deps, coordinator } = buildRestockDeps();
        expect(await run(deps)).toEqual(failClosed);
        expectLog('preflight', route === 'legacy' ? 'legacy' : 'unknown');
        expect(coordinator.coordinate).not.toHaveBeenCalled();
      });

      it('never reads historical IDs or rereads a decision for logging', async () => {
        const { deps, coordinator } = buildRestockDeps();
        const decision = jest
          .fn()
          .mockReturnValueOnce('hold')
          .mockReturnValueOnce('existing');
        const poison = jest.fn(() => {
          throw new Error('PRIVATE-poll');
        });
        coordinator.coordinate.mockResolvedValue(
          Object.defineProperties(
            {},
            {
              decision: { get: decision },
              historicalPollId: { get: poison },
            },
          ),
        );
        expect(await run(deps)).toEqual(success);
        expectLog('coordinator', 'existing');
        expect(decision).toHaveBeenCalledTimes(2);
        expect(poison).not.toHaveBeenCalled();
      });

      it.each([
        ['logger', 'recorded'],
        ['logger', 'hold'],
        ['logger', 'blocked'],
        ['uuid', 'recorded'],
        ['uuid', 'hold'],
        ['uuid', 'blocked'],
      ])('%s failure preserves %s', async (failure, decision) => {
        (failure === 'logger' ? log : uuid).mockImplementation(() => {
          throw new Error('PRIVATE-observation');
        });
        const { deps, coordinator, getStock, create } = buildRestockDeps();
        coordinator.coordinate.mockResolvedValue({ decision });
        expect(await run(deps)).toEqual(
          decision === 'recorded' ? success : failClosed,
        );
        expect(getStock).toHaveBeenCalledTimes(1);
        expect(coordinator.coordinate).toHaveBeenCalledTimes(1);
        expect(getStock.mock.invocationCallOrder[0]).toBeLessThan(
          coordinator.coordinate.mock.invocationCallOrder[0],
        );
        expect(create).not.toHaveBeenCalled();
      });

      it('does not initialize diagnostics for default-off or other kinds', async () => {
        const { deps, create } = buildRestockDeps();
        await run({ ...deps, restock: undefined } as never);
        await makeRequestHumanAssistanceTool(deps).execute(
          { kind: 'expiration_date', digest: expirationDigest },
          { toolCallId: 't', messages: [], context: { senderId: SENDER } },
        );
        expect(create).toHaveBeenCalledTimes(2);
        expect(uuid).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      });

      it('keeps concurrent attempt IDs independent and private inputs absent', async () => {
        const second = '20000000-0000-4000-8000-000000000002';
        uuid.mockReturnValueOnce(attemptId).mockReturnValueOnce(second);
        const { deps, coordinator } = buildRestockDeps();
        coordinator.coordinate.mockResolvedValue({
          decision: 'PRIVATE-decision',
          reason: 'PRIVATE-reason',
        });
        expect(await Promise.all([run(deps), run(deps)])).toEqual([
          failClosed,
          failClosed,
        ]);
        expect(
          log.mock.calls.map(([message]) => message as string).sort(),
        ).toEqual(
          [attemptId, second].map(
            (id) =>
              `restock_diagnostic attemptId=${id} stage=coordinator outcome=unknown reason=none`,
          ),
        );
        const logged = JSON.stringify(log.mock.calls);
        for (const secret of [
          SENDER,
          PRODUCT_ID,
          INBOUND.messageId,
          INBOUND.receivingPhoneNumberId,
          'Croquetas',
          'BACKEND-POLL-ID-1',
          'PRIVATE',
          deriveRestockSourceRequestId(INBOUND),
        ]) {
          expect(logged).not.toContain(secret);
        }
      });
    });

    const promotionDigest = {
      items: [{ productId: PRODUCT_ID, quantity: 1, unitPriceCents: 100 }],
    };
    const expirationDigest = {
      productId: PRODUCT_ID,
      name: 'Croquetas',
      question: 'Expiration date?',
    };

    it.each([
      outOfStockInput,
      { kind: 'needs_human_review', digest: promotionDigest },
      { kind: 'expiration_date', digest: expirationDigest },
    ])('preserves valid $kind inputs', async (input) => {
      const { deps, create } = buildRestockDeps();
      const tool = makeRequestHumanAssistanceTool({
        ...deps,
        restock: undefined,
      });
      const parsed = schemaToolView(tool).inputSchema.safeParse(input);
      expect(parsed).toEqual({ success: true, data: input });
      await tool.execute(input as Parameters<typeof tool.execute>[0], {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER },
      });
      expect(create).toHaveBeenCalledWith({
        senderId: SENDER,
        kind: input.kind,
        digest: { ...input.digest, kind: input.kind },
      });
    });

    it.each([
      { kind: 'shipping_approval', digest: outOfStockInput.digest },
      { kind: 'out_of_stock', digest: promotionDigest },
      { kind: 'needs_human_review', digest: outOfStockInput.digest },
      { kind: 'expiration_date', digest: outOfStockInput.digest },
      ...[
        { productId: 'invalid' },
        { variantId: 'invalid' },
        { name: '' },
        { quantity: 0 },
        { quantity: 1.5 },
      ].map((patch) => ({
        kind: 'out_of_stock',
        digest: { ...outOfStockInput.digest, ...patch },
      })),
      ...[
        { productId: 'invalid' },
        { variantId: 'invalid' },
        { quantity: 0 },
        { quantity: 1.5 },
        { unitPriceCents: -1 },
        { unitPriceCents: 1.5 },
      ].map((patch) => ({
        kind: 'needs_human_review',
        digest: { items: [{ ...promotionDigest.items[0], ...patch }] },
      })),
      { kind: 'needs_human_review', digest: { items: [] } },
      ...[
        { originalTotalCents: -1 },
        { originalTotalCents: 1.5 },
        { recomputedTotalCents: -1 },
        { recomputedTotalCents: 1.5 },
      ].map((patch) => ({
        kind: 'needs_human_review',
        digest: { ...promotionDigest, ...patch },
      })),
      {
        kind: 'expiration_date',
        digest: { ...expirationDigest, question: '' },
      },
    ])('fences invalid input %# before side effects', async (input) => {
      for (const enabled of [false, true]) {
        const { deps, create, markers, coordinator, getState, getStock } =
          buildRestockDeps();
        const tool = makeRequestHumanAssistanceTool({
          ...deps,
          restock: enabled ? deps.restock : undefined,
        });
        expect(schemaToolView(tool).inputSchema.safeParse(input).success).toBe(
          false,
        );
        await expect(
          tool.execute(input as Parameters<typeof tool.execute>[0], {
            toolCallId: 't',
            messages: [],
            context: { senderId: SENDER, inboundEvent: INBOUND },
          }),
        ).rejects.toThrow();
        for (const effect of [
          create,
          markers.readForSender,
          coordinator.coordinate,
          getState,
          getStock,
        ]) {
          expect(effect).not.toHaveBeenCalled();
        }
      }
    });

    it('default-off (no restock capability): out_of_stock keeps the exact legacy create call', async () => {
      const create = jest.fn(
        async (): Promise<HumanHandoffCreateResult> => ({
          ok: true,
          requestId: 'abc123def456',
          ref: 'HF-abc123def456',
          customerNotified: true,
        }),
      );
      const tool = makeRequestHumanAssistanceTool({
        cashierUserId: '00000000-0000-4000-8000-000000000001',
        chatbotApi: {} as never,
        store: {} as never,
        humanHandoffService: { create } as never,
      });
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(create).toHaveBeenCalledWith({
        senderId: SENDER,
        kind: 'out_of_stock',
        digest: {
          kind: 'out_of_stock',
          productId: PRODUCT_ID,
          name: 'Croquetas',
        },
      });
      expect(result).toEqual({
        ok: true,
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        customerNotified: true,
      });
    });

    it('enabled: a non-out_of_stock kind still takes the exact legacy path', async () => {
      const { deps, markers, coordinator, create, getStock, getState } =
        buildRestockDeps();
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(
        {
          kind: 'needs_human_review',
          digest: {
            items: [
              { productId: PRODUCT_ID, quantity: 1, unitPriceCents: 100 },
            ],
          },
        },
        { toolCallId: 't', messages: [], context: { senderId: SENDER } },
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(markers.readForSender).not.toHaveBeenCalled();
      expect(getStock).not.toHaveBeenCalled();
      expect(getState).not.toHaveBeenCalled();
      expect(coordinator.coordinate).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        customerNotified: true,
      });
    });

    it('enabled out_of_stock with no inbound identity fails closed with no legacy fallback or POST', async () => {
      const { deps, coordinator, create } = buildRestockDeps();
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER },
      });
      expect(create).not.toHaveBeenCalled();
      expect(coordinator.coordinate).not.toHaveBeenCalled();
      expect(result).toEqual(failClosed);
    });

    it('enabled out_of_stock with conflicting markers fails closed with no fallback or POST', async () => {
      const { deps, coordinator, create } = buildRestockDeps({
        markers: {
          readForSender: jest.fn(async () => ({
            legacyRequestPending: true,
            restockIntentPresent: true,
          })),
        },
      });
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(create).not.toHaveBeenCalled();
      expect(coordinator.coordinate).not.toHaveBeenCalled();
      expect(result).toEqual(failClosed);
    });

    it('enabled out_of_stock with a marker read failure fails closed before any catalog read', async () => {
      const { deps, coordinator, create, getStock } = buildRestockDeps({
        markers: {
          readForSender: jest.fn(async () => {
            throw new Error('db down');
          }),
        },
      });
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(create).not.toHaveBeenCalled();
      expect(getStock).not.toHaveBeenCalled();
      expect(coordinator.coordinate).not.toHaveBeenCalled();
      expect(result).toEqual(failClosed);
    });

    it('enabled out_of_stock with a catalog read failure fails closed with no POST', async () => {
      const { deps, coordinator, create } = buildRestockDeps({
        getStock: jest.fn(async () => {
          throw new Error('catalog down');
        }),
      });
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(create).not.toHaveBeenCalled();
      expect(coordinator.coordinate).not.toHaveBeenCalled();
      expect(result).toEqual(failClosed);
    });

    it('enabled bound out_of_stock routes the derived intake to the coordinator and reports only the historical record', async () => {
      const { deps, coordinator, create } = buildRestockDeps();
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(create).not.toHaveBeenCalled();
      expect(coordinator.coordinate).toHaveBeenCalledTimes(1);
      const expectedArg = expect.objectContaining({
        senderId: SENDER,
        intake: expect.objectContaining({
          type: 'RESTOCK',
          productId: PRODUCT_ID,
          sourceRequestId: deriveRestockSourceRequestId(INBOUND),
        }) as unknown,
      }) as unknown;
      expect(coordinator.coordinate).toHaveBeenCalledWith(expectedArg);
      expect(result).toEqual({
        ok: true,
        outcome: 'historical_intake_recorded',
        customerNotified: false,
      });
    });

    it('enabled coordinator existing record reports the same sanitized outcome without leaking the poll id', async () => {
      const { deps, create } = buildRestockDeps({
        coordinator: {
          coordinate: jest.fn(async () => ({
            decision: 'existing' as const,
            historicalPollId: 'BACKEND-POLL-ID-1',
          })),
        },
      });
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(create).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        outcome: 'historical_intake_recorded',
        customerNotified: false,
      });
      expect(JSON.stringify(result)).not.toContain('BACKEND-POLL-ID-1');
    });

    it('enabled ambiguous coordinator hold fails closed and never fabricates a notice', async () => {
      const { deps, coordinator, create } = buildRestockDeps({
        coordinator: {
          coordinate: jest.fn(async () => ({
            decision: 'hold' as const,
            reason: 'unknown_hold' as const,
          })),
        },
      });
      const tool = makeRequestHumanAssistanceTool(deps);
      const result = await tool.execute(outOfStockInput, {
        toolCallId: 't',
        messages: [],
        context: { senderId: SENDER, inboundEvent: INBOUND },
      });
      expect(coordinator.coordinate).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(result).toEqual(failClosed);
    });
  });
});
