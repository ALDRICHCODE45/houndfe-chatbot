import { ConfigService } from '@nestjs/config';
import type {
  ConversationStore,
  ConversationState,
} from '../../conversation/domain/conversation-store';
import type {
  ReservationDecision,
  SharedReservationPort,
} from '../../human-decisions/domain/shared-reservation';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import { shippingApprovalPolicyAdapter } from '../../shipping/application/shipping-approval-policy.adapter';
import type {
  ShippingApprovalDecision,
  ShippingApprovalPinResult,
  ShippingApprovalPolicy,
} from '../domain/shipping-approval-policy.port';
import type {
  CreateHumanHandoffInput,
  HumanHandoffStore,
} from '../domain/human-handoff-store.port';
import type {
  HumanHandoffDigest,
  HumanHandoffResolution,
  HumanHandoffRequest,
  ShippingApprovalDigest,
} from '../domain/human-handoff.types';
import {
  UNDER_REVIEW_NOTICE,
  PENDING_HUMAN_REQUEST_REPLY,
  ASK_FOR_REF,
  SHIPPING_DECISION_GRAMMAR,
  SHIPPING_REQUOTE_REPLY,
  SHIPPING_RETRY_REPLY,
  HumanHandoffService,
  formatResolutionAsUserTurn,
} from './human-handoff.service';

/**
 * Contract tests for HumanHandoffService.
 *
 * Spec scenarios (human-handoff §"HumanHandoffService"):
 *   - (a) happy path: create writes a row + sends the digest + sends the
 *       customer notice + sets the marker; returns the success envelope.
 *   - (b) idempotent re-call: a second create for the same sender with
 *       pendingHumanRequest set returns the existing envelope.
 *   - (c) disabled kill-switch: enabled=false returns the disabled envelope
 *       and does NOT call store.create or whatsappSender.sendText.
 *   - (d) resolveReply with explicit ref token parses + resolves + clears.
 *   - (e) no-token fallback to newest pending request for the agent.
 *   - (f) no-token + no pending returns { kind: 'no_pending', reply }.
 *   - (g) bare prose is GENERIC; per-kind phrasing carries the kind + text.
 *   - (h) case/whitespace tolerant parser.
 *   - (i) isOpsSender compares sender and ops wa_id under the explicit
 *       sandbox recipient normalization mode (exact by default).
 *   - byte-identical UNDER_REVIEW_NOTICE + PENDING_HUMAN_REQUEST_REPLY literals.
 */
describe('HumanHandoffService', () => {
  let store: jest.Mocked<HumanHandoffStore>;
  let whatsappSender: jest.Mocked<WhatsappSenderPort>;
  let conversationStore: jest.Mocked<ConversationStore>;
  let configService: ConfigService;
  let reservations: jest.Mocked<SharedReservationPort>;
  let service: HumanHandoffService;

  const OPS = '5219999888777';
  const CUSTOMER = '5215550001111';
  const REF_ID = 'abc123def456';

  beforeEach(() => {
    store = {
      create: jest.fn(),
      findById: jest.fn(),
      findByRef: jest.fn(),
      findLatestPendingForAgent: jest.fn(),
      resolve: jest.fn(),
    };

    whatsappSender = {
      sendText: jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'wamid.outbound' }),
    };

    conversationStore = {
      commitAgentTurn: jest.fn().mockResolvedValue(true),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setPendingHumanRequest: jest.fn(),
      clearPendingHumanRequest: jest.fn(),
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
    };
    // CAS primitives default to success; per-test overrides flip them.
    conversationStore.setPendingHumanRequest.mockResolvedValue(true);
    conversationStore.clearPendingHumanRequest.mockResolvedValue(true);

    configService = {
      get: (key: string) => {
        if (key === 'humanHandoff.enabled') return true;
        if (key === 'humanHandoff.opsChannelPhone') return OPS;
        return undefined;
      },
    } as unknown as ConfigService;

    reservations = {
      reserve: jest.fn().mockResolvedValue({
        action: 'claim',
        reason: 'single_sender_vacant',
      }),
      closeLegacyResolved: jest.fn().mockResolvedValue(true),
    };

    service = new HumanHandoffService(
      store,
      whatsappSender,
      conversationStore,
      configService,
      reservations,
      shippingApprovalPolicyAdapter,
    );
  });

  describe('byte-identical constants', () => {
    it('UNDER_REVIEW_NOTICE matches the spec literal', () => {
      expect(UNDER_REVIEW_NOTICE).toBe(
        'Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.',
      );
    });

    it('PENDING_HUMAN_REQUEST_REPLY matches the spec literal', () => {
      expect(PENDING_HUMAN_REQUEST_REPLY).toBe(
        'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos',
      );
    });

    it('ASK_FOR_REF is a non-empty string asking for the ref code', () => {
      expect(ASK_FOR_REF.length).toBeGreaterThan(0);
      expect(ASK_FOR_REF).toMatch(/HF-/);
    });
  });

  describe('isOpsSender', () => {
    it('matches exact wa_id equality when sandbox normalization is disabled (default)', () => {
      expect(service.isOpsSender(OPS)).toBe(true);
      expect(service.isOpsSender('529999888777')).toBe(false);
      expect(service.isOpsSender('5215550001111')).toBe(false);
    });

    it('returns false when opsChannelPhone is unset', () => {
      const noOps = new HumanHandoffService(
        store,
        whatsappSender,
        conversationStore,
        {
          get: (key: string) =>
            key === 'humanHandoff.enabled' ? true : undefined,
        } as unknown as ConfigService,
        reservations,
        shippingApprovalPolicyAdapter,
      );
      expect(noOps.isOpsSender('5219999888777')).toBe(false);
    });

    it('supports the historical trunk-1 matching when sandbox normalization is enabled', () => {
      const sandboxService = new HumanHandoffService(
        store,
        whatsappSender,
        conversationStore,
        {
          get: (key: string) =>
            key === 'humanHandoff.opsChannelPhone'
              ? OPS
              : key === 'meta.sandboxRecipientNormalizationEnabled',
        } as unknown as ConfigService,
        reservations,
        shippingApprovalPolicyAdapter,
      );

      expect(sandboxService.isOpsSender('5219999888777')).toBe(true);
      expect(sandboxService.isOpsSender('529999888777')).toBe(true);
    });
  });

  describe('create', () => {
    it('happy path: writes row + sends digest + sends notice + sets marker', async () => {
      const now = new Date('2026-06-23T12:00:00.000Z').toISOString();
      jest.useFakeTimers().setSystemTime(new Date(now));

      const prior: ConversationState = {
        senderId: CUSTOMER,
        lastMessageAt: now,
        data: { cart: { items: [], idempotencyKey: 'k' } },
      };
      conversationStore.get.mockResolvedValue(prior);

      store.create.mockImplementation(
        async (input: CreateHumanHandoffInput) => ({
          id: input.id,
          customerId: input.customerId,
          agentId: input.agentId,
          kind: input.kind,
          digest: input.digest,
          status: 'pending',
          resolution: null,
          createdAt: now,
          resolvedAt: null,
        }),
      );

      const result = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: {
          kind: 'out_of_stock',
          productId: '00000000-0000-4000-8000-000000000001',
          name: 'Croquetas',
          quantity: 1,
        },
      });

      expect(store.create).toHaveBeenCalledTimes(1);
      const [created] = store.create.mock.calls[0];
      expect(created.customerId).toBe(CUSTOMER);
      expect(created.agentId).toBe(OPS);
      expect(created.kind).toBe('out_of_stock');
      expect(created.id).toMatch(/^[a-f0-9]{12}$/);

      expect(whatsappSender.sendText).toHaveBeenCalledTimes(2);
      const opsCall = whatsappSender.sendText.mock.calls.find(
        (c) => c[0].to === OPS,
      );
      const customerCall = whatsappSender.sendText.mock.calls.find(
        (c) => c[0].to === CUSTOMER,
      );
      expect(opsCall).toBeDefined();
      expect(opsCall![0].text).toContain(`HF-${created.id}`);
      expect(customerCall).toBeDefined();
      expect(customerCall![0].text).toBe(UNDER_REVIEW_NOTICE);

      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(conversationStore.setPendingHumanRequest).toHaveBeenCalledTimes(1);
      const [markerSender, marker, markerTs] =
        conversationStore.setPendingHumanRequest.mock.calls[0];
      expect(markerSender).toBe(CUSTOMER);
      expect(marker).toEqual({
        requestId: created.id,
        ref: `HF-${created.id}`,
        createdAt: now,
        customerNotifiedAt: now,
      });
      expect(markerTs).toBe(now);
      // The ops digest MUST precede the CAS set, the CAS set the notice.
      expect(whatsappSender.sendText.mock.calls.map((c) => c[0].to)).toEqual([
        OPS,
        CUSTOMER,
      ]);

      expect(result).toEqual({
        ok: true,
        requestId: created.id,
        ref: `HF-${created.id}`,
        customerNotified: true,
      });

      jest.useRealTimers();
    });

    it('idempotent re-call: returns existing envelope without new writes/sends', async () => {
      const now = new Date('2026-06-23T12:00:00.000Z').toISOString();
      jest.useFakeTimers().setSystemTime(new Date(now));

      const marker = {
        requestId: REF_ID,
        ref: `HF-${REF_ID}`,
        createdAt: now,
        customerNotifiedAt: now,
      };
      conversationStore.get.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: now,
        data: { pendingHumanRequest: marker },
      });

      const result = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: {
          kind: 'out_of_stock',
          productId: 'p',
          name: 'X',
        },
      });

      expect(store.create).not.toHaveBeenCalled();
      expect(whatsappSender.sendText).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(reservations.reserve).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        requestId: REF_ID,
        ref: `HF-${REF_ID}`,
        customerNotified: true,
      });

      jest.useRealTimers();
    });

    it('disabled kill-switch: returns disabled envelope without writes/sends', async () => {
      const disabledConfig = {
        get: (key: string) =>
          key === 'humanHandoff.enabled'
            ? false
            : key === 'humanHandoff.opsChannelPhone'
              ? OPS
              : undefined,
      } as unknown as ConfigService;
      const disabled = new HumanHandoffService(
        store,
        whatsappSender,
        conversationStore,
        disabledConfig,
        reservations,
        shippingApprovalPolicyAdapter,
      );

      const result = await disabled.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: {
          kind: 'out_of_stock',
          productId: 'p',
          name: 'X',
        },
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: 'disabled', retryable: false },
      });
      expect(store.create).not.toHaveBeenCalled();
      expect(whatsappSender.sendText).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(reservations.reserve).not.toHaveBeenCalled();
    });

    it('reserves LEGACY_OPS before store.create and proceeds only on claim', async () => {
      const order: string[] = [];
      reservations.reserve.mockImplementation(async () => {
        order.push('reserve');
        return { action: 'claim', reason: 'single_sender_vacant' };
      });
      store.create.mockImplementation(
        async (input: CreateHumanHandoffInput) => {
          order.push('create');
          return {
            id: input.id,
            customerId: input.customerId,
            agentId: input.agentId,
            kind: input.kind,
            digest: input.digest,
            status: 'pending',
            resolution: null,
            createdAt: '2026-06-23T12:00:00.000Z',
            resolvedAt: null,
          };
        },
      );
      conversationStore.get.mockResolvedValue(null);

      const result = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: {
          kind: 'out_of_stock',
          productId: '00000000-0000-4000-8000-000000000001',
          name: 'Croquetas',
          quantity: 1,
        },
      });

      expect(result.ok).toBe(true);
      expect(order).toEqual(['reserve', 'create']);
      const [proposal] = reservations.reserve.mock.calls[0];
      expect(proposal.senderId).toBe(CUSTOMER);
      expect(proposal.route).toBe('LEGACY_OPS');
      expect(proposal.requestKey).toMatch(/^[a-f0-9]{12}$/);
      expect(proposal.intake).toBeNull();
    });

    const denied: ReservationDecision[] = [
      { action: 'replay', reason: 'exact_active_replay' },
      { action: 'occupied_legacy', reason: 'legacy_marker_present' },
      {
        action: 'occupied',
        reason: 'different_active_key',
        activeRoute: 'RESTOCK',
      },
      { action: 'conflict', reason: 'same_key_different_payload' },
      { action: 'blocked', reason: 'unknown_existing' },
    ];
    it.each(denied)(
      'fails closed on non-claim reservation %#',
      async (decision) => {
        reservations.reserve.mockResolvedValue(decision);
        conversationStore.get.mockResolvedValue(null);

        const result = await service.create({
          senderId: CUSTOMER,
          kind: 'out_of_stock',
          digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
        });

        expect(result).toEqual({
          ok: false,
          error: { kind: 'unavailable', retryable: false },
        });
        expect(store.create).not.toHaveBeenCalled();
        expect(whatsappSender.sendText).not.toHaveBeenCalled();
        expect(conversationStore.update).not.toHaveBeenCalled();
      },
    );

    it('fails closed when the reservation throws', async () => {
      reservations.reserve.mockRejectedValue(new Error('db down'));
      conversationStore.get.mockResolvedValue(null);

      const result = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: 'unavailable', retryable: false },
      });
      expect(store.create).not.toHaveBeenCalled();
      expect(whatsappSender.sendText).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
    });

    it('keeps the claim and returns no success when store.create fails after claim', async () => {
      conversationStore.get.mockResolvedValue(null);
      store.create.mockRejectedValue(new Error('insert failed'));

      await expect(
        service.create({
          senderId: CUSTOMER,
          kind: 'out_of_stock',
          digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
        }),
      ).rejects.toThrow('insert failed');
      // No release API: the claim stays ACTIVE and reserve is attempted once.
      expect(reservations.reserve).toHaveBeenCalledTimes(1);
    });

    it('keeps ACTIVE and denies the retry when a send fails after claim', async () => {
      conversationStore.get.mockResolvedValue(null);
      store.create.mockImplementation(
        async (created: CreateHumanHandoffInput) => ({
          id: created.id,
          customerId: created.customerId,
          agentId: created.agentId,
          kind: created.kind,
          digest: created.digest,
          status: 'pending',
          resolution: null,
          createdAt: '2026-06-23T12:00:00.000Z',
          resolvedAt: null,
        }),
      );
      whatsappSender.sendText.mockRejectedValueOnce(new Error('meta down'));

      await expect(
        service.create({
          senderId: CUSTOMER,
          kind: 'out_of_stock',
          digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
        }),
      ).rejects.toThrow('meta down');
      expect(reservations.reserve).toHaveBeenCalledTimes(1);

      // The claim stays ACTIVE, so the retry is denied with no second effect.
      reservations.reserve.mockResolvedValue({
        action: 'occupied',
        reason: 'different_active_key',
        activeRoute: 'LEGACY_OPS',
      });
      const retry = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
      });
      expect(retry).toEqual({
        ok: false,
        error: { kind: 'unavailable', retryable: false },
      });
      expect(store.create).toHaveBeenCalledTimes(1);
      expect(whatsappSender.sendText).toHaveBeenCalledTimes(1);
    });

    it('fails closed without a customer notice when the marker CAS conflicts', async () => {
      conversationStore.get.mockResolvedValue(null);
      conversationStore.setPendingHumanRequest.mockResolvedValue(false);
      store.create.mockResolvedValue({
        id: 'x',
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
      } as unknown as HumanHandoffRequest);

      const result = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: 'unavailable', retryable: false },
      });
      expect(conversationStore.setPendingHumanRequest).toHaveBeenCalledTimes(1);
      // Ops digest may already be out; the customer was never notified.
      expect(whatsappSender.sendText.mock.calls.map((c) => c[0].to)).toEqual([
        OPS,
      ]);
    });
  });

  describe('shipping_approval ops rendering', () => {
    const now = '2026-06-23T12:00:00.000Z';

    const shippingDigest = (
      overrides: Partial<ShippingApprovalDigest> = {},
    ): ShippingApprovalDigest => ({
      kind: 'shipping_approval',
      draftCreatedAt: now,
      customerPaysCents: 6_901,
      totalCreditCents: 12_000,
      carrierName: 'Skydropx Express',
      serviceName: 'DHL Express',
      estimatedDeliveryDays: 3,
      ...overrides,
    });

    const runCreate = async (digest: HumanHandoffDigest) => {
      jest.useFakeTimers().setSystemTime(new Date(now));
      conversationStore.get.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: now,
        data: {},
      });
      store.create.mockImplementation(
        async (input: CreateHumanHandoffInput) => ({
          id: input.id,
          customerId: input.customerId,
          agentId: input.agentId,
          kind: input.kind,
          digest: input.digest,
          status: 'pending',
          resolution: null,
          createdAt: now,
          resolvedAt: null,
        }),
      );
      await service.create({
        senderId: CUSTOMER,
        kind: 'shipping_approval',
        digest,
      });
      jest.useRealTimers();
      const ref = `HF-${store.create.mock.calls[0][0].id}`;
      const opsText = whatsappSender.sendText.mock.calls.find(
        (c) => c[0].to === OPS,
      )![0].text;
      const customerText = whatsappSender.sendText.mock.calls.find(
        (c) => c[0].to === CUSTOMER,
      )![0].text;
      return { ref, opsText, customerText };
    };

    it('renders the exact redacted lines and the pending customer notice', async () => {
      const { ref, opsText, customerText } = await runCreate(shippingDigest());
      expect(opsText).toBe(
        [
          '🔔 HoundFe — solicitud de agente humano',
          `Ref: ${ref}`,
          'Tipo: shipping_approval',
          'Cobro de envío: 69.01 MXN',
          'Crédito total: 120.00 MXN',
          'Paquetería: Skydropx Express',
          'Servicio: DHL Express',
          'Entrega estimada: 3 día(s)',
          `Responde con "${ref}: APPROVE_SHIPPING" o "${ref}: REJECT_SHIPPING"`,
        ].join('\n'),
      );
      expect(customerText).toBe(UNDER_REVIEW_NOTICE);
    });

    it('formats zero amounts as 0.00 and a null ETA as no disponible', async () => {
      const { opsText } = await runCreate(
        shippingDigest({
          customerPaysCents: 0,
          totalCreditCents: 0,
          estimatedDeliveryDays: null,
        }),
      );
      expect(opsText).toContain('Cobro de envío: 0.00 MXN');
      expect(opsText).toContain('Crédito total: 0.00 MXN');
      expect(opsText).toContain('Entrega estimada: no disponible');
    });

    it('renders only allowed fields, ignoring hostile digest keys', async () => {
      const hostile = {
        ...shippingDigest(),
        draftCreatedAt: 'HOSTILE_DRAFT_PIN',
        quoteId: 'QUOTE_SECRET',
        rateId: 'RATE_SECRET',
        address: 'ADDRESS_SECRET',
        phone: 'PHONE_SECRET',
        product: 'PRODUCT_SECRET',
        measurements: 'MEASUREMENTS_SECRET',
        provider: 'PROVIDER_SECRET',
        error: 'ERROR_SECRET',
        expiresAt: 'EXPIRES_SECRET',
        grossCents: 111,
        bestCents: 222,
        appliedCents: 333,
        unusedCents: 444,
        qualifyingCount: 555,
        customerId: 'CUSTOMER_SECRET',
        arbitrary: 'ARBITRARY_SECRET',
      } as unknown as HumanHandoffDigest;
      const before = structuredClone(hostile);
      const { opsText } = await runCreate(hostile);
      for (const leaked of [
        'QUOTE_SECRET',
        'RATE_SECRET',
        'ADDRESS_SECRET',
        'PHONE_SECRET',
        'PRODUCT_SECRET',
        'MEASUREMENTS_SECRET',
        'PROVIDER_SECRET',
        'ERROR_SECRET',
        'EXPIRES_SECRET',
        'HOSTILE_DRAFT_PIN',
        'CUSTOMER_SECRET',
        'ARBITRARY_SECRET',
      ]) {
        expect(opsText).not.toContain(leaked);
      }
      expect(hostile).toEqual(before);
    });
  });

  describe('formatResolutionAsUserTurn shipping decisions', () => {
    const now = '2026-06-23T12:00:00.000Z';
    const ref = `HF-${REF_ID}`;
    const shippingRequest: HumanHandoffRequest = {
      id: REF_ID,
      customerId: CUSTOMER,
      agentId: OPS,
      kind: 'shipping_approval',
      digest: {
        kind: 'shipping_approval',
        draftCreatedAt: now,
        customerPaysCents: 6_901,
        totalCreditCents: 12_000,
        carrierName: 'CARRIER_LEAK',
        serviceName: 'SERVICE_LEAK',
        estimatedDeliveryDays: 3,
      },
      status: 'pending',
      resolution: null,
      createdAt: now,
      resolvedAt: null,
    };
    const cases: Array<[HumanHandoffResolution, string]> = [
      [
        { decision: 'SHIPPING_APPROVED', draftCreatedAt: now },
        `[Resolución del agente humano (${ref})] El agente aprobó el envío.`,
      ],
      [
        { decision: 'SHIPPING_REJECTED', draftCreatedAt: now },
        `[Resolución del agente humano (${ref})] El agente rechazó el envío.`,
      ],
      [
        {
          decision: 'SHIPPING_EXPIRED',
          draftCreatedAt: now,
          reason: 'draft_expired',
        },
        `[Resolución del agente humano (${ref})] La cotización de envío ya no es válida.`,
      ],
    ];

    it('renders exact amount-free turns leaking no pin/money/carrier/ETA/reason', () => {
      for (const [resolution, expected] of cases) {
        const text = formatResolutionAsUserTurn(shippingRequest, resolution);
        expect(text).toBe(expected);
        for (const leaked of [
          '6901',
          '69.01',
          '12000',
          '120.00',
          'CARRIER_LEAK',
          'SERVICE_LEAK',
          'draft_expired',
          now.slice(0, 10),
        ]) {
          expect(text).not.toContain(leaked);
        }
      }
    });
  });

  describe('resolveReply', () => {
    const customerStateFor = (
      customerId: string,
      marker: ConversationState['data']['pendingHumanRequest'] = null,
    ): ConversationState => ({
      senderId: customerId,
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { pendingHumanRequest: marker },
    });

    // Pre-clear read supplies `lastMessageAt` to the CAS clear.
    beforeEach(() => {
      conversationStore.get.mockResolvedValue(customerStateFor(CUSTOMER));
    });

    const pendingMarker = {
      requestId: REF_ID,
      ref: `HF-${REF_ID}`,
      createdAt: '2026-06-23T12:00:00.000Z',
      customerNotifiedAt: '2026-06-23T12:00:00.000Z',
    };

    const baseRequest: HumanHandoffRequest = {
      id: REF_ID,
      customerId: CUSTOMER,
      agentId: OPS,
      kind: 'out_of_stock',
      digest: {
        kind: 'out_of_stock',
        productId: '00000000-0000-4000-8000-000000000001',
        name: 'Croquetas',
      },
      status: 'pending',
      resolution: null,
      createdAt: '2026-06-23T12:00:00.000Z',
      resolvedAt: null,
    };

    it('explicit ref token: parses + resolves + clears marker + returns synthetic text', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, {
          requestId: REF_ID,
          ref: `HF-${REF_ID}`,
          createdAt: '2026-06-23T12:00:00.000Z',
          customerNotifiedAt: '2026-06-23T12:00:00.000Z',
        }),
      );

      const result = await service.resolveReply({
        text: `HF-${REF_ID} YES_RESTOCK_IN_X_DAYS:3`,
        from: OPS,
      });

      expect(store.findByRef).toHaveBeenCalledWith(`HF-${REF_ID}`);
      expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
        decision: 'YES_RESTOCK_IN_X_DAYS',
        days: 3,
      });
      expect(conversationStore.clearPendingHumanRequest).toHaveBeenCalledWith(
        CUSTOMER,
        REF_ID,
        '2026-06-23T12:00:00.000Z',
      );
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.customerId).toBe(CUSTOMER);
        expect(result.ref).toBe(`HF-${REF_ID}`);
        expect(result.resolution).toEqual({
          decision: 'YES_RESTOCK_IN_X_DAYS',
          days: 3,
        });
        expect(result.syntheticUserText).toContain('restock');
        expect(result.syntheticUserText).toContain('3');
      }
    });

    it('nonshipping resolve loses CAS (null): fails closed with no_pending and clears nothing', async () => {
      // SQ-5C2c2b4a: a losing resolve (row already resolved by a concurrent
      // reply) returns null. The service MUST NOT clear the customer marker,
      // emit a synthetic losing decision, or report a resolved envelope.
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockResolvedValue(null);
      conversationStore.get.mockResolvedValue(
        customerStateFor(CUSTOMER, {
          requestId: REF_ID,
          ref: `HF-${REF_ID}`,
          createdAt: '2026-06-23T12:00:00.000Z',
          customerNotifiedAt: '2026-06-23T12:00:00.000Z',
        }),
      );

      const result = await service.resolveReply({
        text: `HF-${REF_ID} NO_RESTOCK`,
        from: OPS,
      });

      expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
        decision: 'NO_RESTOCK',
      });
      expect(result).toEqual({ kind: 'no_pending', reply: ASK_FOR_REF });
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(whatsappSender.sendText).not.toHaveBeenCalled();
    });

    it('ref token present but no row: falls back to the newest pending for the agent', async () => {
      // Spec step 2 (human-handoff §"resolveReply parses the HF-<id> token
      // and falls back to newest-pending"): a token that finds NO row must
      // fall back to findLatestPendingForAgent(from) instead of returning
      // no_pending immediately.
      const fallback: HumanHandoffRequest = {
        ...baseRequest,
        id: 'fbabc0000001',
        createdAt: '2026-06-23T12:30:00.000Z',
      };
      store.findByRef.mockResolvedValue(null);
      store.findLatestPendingForAgent.mockResolvedValue(fallback);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...fallback,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:35:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, {
          requestId: 'fbabc0000001',
          ref: 'HF-fbabc0000001',
          createdAt: '2026-06-23T12:30:00.000Z',
          customerNotifiedAt: '2026-06-23T12:30:00.000Z',
        }),
      );

      const result = await service.resolveReply({
        text: 'HF-unknown000000 NO_RESTOCK',
        from: OPS,
      });

      expect(store.findByRef).toHaveBeenCalledWith('HF-unknown000000');
      expect(store.findLatestPendingForAgent).toHaveBeenCalledWith(OPS);
      expect(store.resolve).toHaveBeenCalledWith('fbabc0000001', {
        decision: 'NO_RESTOCK',
      });
      expect(result.kind).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.customerId).toBe(CUSTOMER);
      }
    });

    it('no-token fallback: picks the newest pending request for the agent', async () => {
      const newer: HumanHandoffRequest = {
        ...baseRequest,
        id: 'newer0000000',
        createdAt: '2026-06-23T13:00:00.000Z',
      };
      store.findLatestPendingForAgent.mockResolvedValue(newer);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...newer,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T13:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, {
          requestId: 'newer0000000',
          ref: 'HF-newer0000000',
          createdAt: '2026-06-23T13:00:00.000Z',
          customerNotifiedAt: '2026-06-23T13:00:00.000Z',
        }),
      );

      const result = await service.resolveReply({
        text: 'NO_RESTOCK',
        from: OPS,
      });

      expect(store.findLatestPendingForAgent).toHaveBeenCalledWith(OPS);
      expect(store.resolve).toHaveBeenCalledWith('newer0000000', {
        decision: 'NO_RESTOCK',
      });
      expect(result.kind).toBe('resolved');
    });

    it('ref token present but BOTH lookups miss: returns no_pending and does not resolve', async () => {
      store.findByRef.mockResolvedValue(null);
      store.findLatestPendingForAgent.mockResolvedValue(null);

      const result = await service.resolveReply({
        text: 'HF-unknown000000 ok',
        from: OPS,
      });

      expect(store.findByRef).toHaveBeenCalledWith('HF-unknown000000');
      expect(store.findLatestPendingForAgent).toHaveBeenCalledWith(OPS);
      expect(result).toEqual({ kind: 'no_pending', reply: ASK_FOR_REF });
      expect(store.resolve).not.toHaveBeenCalled();
      expect(reservations.closeLegacyResolved).not.toHaveBeenCalled();
    });

    it('no token + no pending: returns { kind: "no_pending", reply: ASK_FOR_REF }', async () => {
      store.findLatestPendingForAgent.mockResolvedValue(null);

      const result = await service.resolveReply({
        text: 'hola',
        from: OPS,
      });

      expect(result).toEqual({ kind: 'no_pending', reply: ASK_FOR_REF });
      expect(store.resolve).not.toHaveBeenCalled();
      expect(reservations.closeLegacyResolved).not.toHaveBeenCalled();
    });

    it('bare prose on expiration_date kind: parses EXPIRATION decision', async () => {
      const expirationRequest: HumanHandoffRequest = {
        ...baseRequest,
        kind: 'expiration_date',
        digest: {
          kind: 'expiration_date',
          productId: '00000000-0000-4000-8000-000000000001',
          name: 'Croquetas',
          question: 'q',
        },
      };
      store.findByRef.mockResolvedValue(expirationRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...expirationRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, {
          requestId: REF_ID,
          ref: `HF-${REF_ID}`,
          createdAt: '2026-06-23T12:00:00.000Z',
          customerNotifiedAt: '2026-06-23T12:00:00.000Z',
        }),
      );

      const result = await service.resolveReply({
        text: `HF-${REF_ID} vence el 30 de noviembre`,
        from: OPS,
      });

      expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
        decision: 'EXPIRATION',
        text: 'vence el 30 de noviembre',
      });
      expect(result.kind).toBe('resolved');
    });

    it('case/whitespace tolerant parser', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, {
          requestId: REF_ID,
          ref: `HF-${REF_ID}`,
          createdAt: '2026-06-23T12:00:00.000Z',
          customerNotifiedAt: '2026-06-23T12:00:00.000Z',
        }),
      );

      await service.resolveReply({
        text: `hf-${REF_ID}   yes_restock_in_x_days :  5`,
        from: OPS,
      });

      expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
        decision: 'YES_RESTOCK_IN_X_DAYS',
        days: 5,
      });
    });

    it('closes the legacy reservation only after resolve + CAS clear', async () => {
      const order: string[] = [];
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => {
        order.push('resolve');
        return {
          ...baseRequest,
          id,
          status: 'resolved',
          resolution,
          resolvedAt: '2026-06-23T12:05:00.000Z',
        };
      });
      conversationStore.get.mockImplementation(async () => {
        order.push('get');
        return customerStateFor(CUSTOMER, pendingMarker);
      });
      conversationStore.clearPendingHumanRequest.mockImplementation(
        async () => {
          order.push('clear');
          return true;
        },
      );
      reservations.closeLegacyResolved.mockImplementation(async () => {
        order.push('close');
        return true;
      });

      const result = await service.resolveReply({
        text: `HF-${REF_ID} NO_RESTOCK`,
        from: OPS,
      });

      expect(result.kind).toBe('resolved');
      expect(order).toEqual(['resolve', 'get', 'clear', 'close']);
      expect(reservations.closeLegacyResolved).toHaveBeenCalledWith(
        CUSTOMER,
        REF_ID,
      );
    });

    it('returns no_pending and does not close when the durable resolve loses CAS', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockResolvedValue(null);

      await expect(
        service.resolveReply({ text: `HF-${REF_ID} NO_RESTOCK`, from: OPS }),
      ).resolves.toEqual({ kind: 'no_pending', reply: ASK_FOR_REF });
      expect(store.resolve).toHaveBeenCalledTimes(1);
      expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
        decision: 'NO_RESTOCK',
      });
      expect(reservations.closeLegacyResolved).not.toHaveBeenCalled();
      expect(conversationStore.clearPendingHumanRequest).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(whatsappSender.sendText).not.toHaveBeenCalled();
    });

    it('throws and does not close when the resolved row mismatches the target', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockResolvedValue({
        ...baseRequest,
        customerId: 'other-customer',
        status: 'resolved',
        resolution: { decision: 'NO_RESTOCK' },
        resolvedAt: '2026-06-23T12:05:00.000Z',
      });

      await expect(
        service.resolveReply({ text: `HF-${REF_ID} NO_RESTOCK`, from: OPS }),
      ).rejects.toThrow();
      expect(reservations.closeLegacyResolved).not.toHaveBeenCalled();
    });

    it('throws and does not close when the marker clear fails', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValue(
        customerStateFor(CUSTOMER, pendingMarker),
      );
      conversationStore.clearPendingHumanRequest.mockRejectedValue(
        new Error('clear failed'),
      );

      await expect(
        service.resolveReply({ text: `HF-${REF_ID} NO_RESTOCK`, from: OPS }),
      ).rejects.toThrow('clear failed');
      expect(reservations.closeLegacyResolved).not.toHaveBeenCalled();
    });

    it('fails closed and does not close when the CAS clear returns false', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.clearPendingHumanRequest.mockResolvedValue(false);

      await expect(
        service.resolveReply({ text: `HF-${REF_ID} NO_RESTOCK`, from: OPS }),
      ).rejects.toThrow();
      expect(reservations.closeLegacyResolved).not.toHaveBeenCalled();
    });

    it('throws instead of returning resolved when the fenced close is false', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, pendingMarker),
      );
      reservations.closeLegacyResolved.mockResolvedValue(false);

      await expect(
        service.resolveReply({ text: `HF-${REF_ID} NO_RESTOCK`, from: OPS }),
      ).rejects.toThrow();
      expect(reservations.closeLegacyResolved).toHaveBeenCalledWith(
        CUSTOMER,
        REF_ID,
      );
    });

    it('rethrows a fenced close failure without retry', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, pendingMarker),
      );
      reservations.closeLegacyResolved.mockRejectedValue(
        new Error('close failed'),
      );

      await expect(
        service.resolveReply({ text: `HF-${REF_ID} NO_RESTOCK`, from: OPS }),
      ).rejects.toThrow('close failed');
      expect(reservations.closeLegacyResolved).toHaveBeenCalledTimes(1);
    });

    it('allows a repeated handoff only after the terminal close', async () => {
      store.findByRef.mockResolvedValue(baseRequest);
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...baseRequest,
        id,
        status: 'resolved',
        resolution,
        resolvedAt: '2026-06-23T12:05:00.000Z',
      }));
      conversationStore.get.mockResolvedValueOnce(
        customerStateFor(CUSTOMER, pendingMarker),
      );

      await service.resolveReply({
        text: `HF-${REF_ID} NO_RESTOCK`,
        from: OPS,
      });
      expect(reservations.closeLegacyResolved).toHaveBeenCalledWith(
        CUSTOMER,
        REF_ID,
      );

      conversationStore.get.mockResolvedValue(null);
      store.create.mockImplementation(
        async (created: CreateHumanHandoffInput) => ({
          id: created.id,
          customerId: created.customerId,
          agentId: created.agentId,
          kind: created.kind,
          digest: created.digest,
          status: 'pending',
          resolution: null,
          createdAt: '2026-06-23T12:10:00.000Z',
          resolvedAt: null,
        }),
      );

      const second = await service.create({
        senderId: CUSTOMER,
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'X' },
      });

      expect(second.ok).toBe(true);
      expect(reservations.reserve).toHaveBeenCalledTimes(1);
    });

    it('reads humanHandoff block from ConfigService (not process.env)', async () => {
      const original = process.env.OPS_CHANNEL_PHONE;
      process.env.OPS_CHANNEL_PHONE = 'DIFFERENT_VALUE';
      try {
        const procCfg = {
          get: (key: string) => {
            if (key === 'humanHandoff.enabled') return true;
            if (key === 'humanHandoff.opsChannelPhone') return OPS;
            return undefined;
          },
        } as unknown as ConfigService;
        const svc = new HumanHandoffService(
          store,
          whatsappSender,
          conversationStore,
          procCfg,
          reservations,
          shippingApprovalPolicyAdapter,
        );
        expect(svc.isOpsSender('5219999888777')).toBe(true);
      } finally {
        if (original === undefined) {
          delete process.env.OPS_CHANNEL_PHONE;
        } else {
          process.env.OPS_CHANNEL_PHONE = original;
        }
      }
    });
  });

  describe('resolveReply shipping_approval (SQ-5C2c2b1)', () => {
    const PIN = '2026-06-23T12:00:00.000Z';
    let policy: jest.Mocked<ShippingApprovalPolicy>;
    let shipping: HumanHandoffService;

    const baseDigest: ShippingApprovalDigest = {
      kind: 'shipping_approval',
      draftCreatedAt: PIN,
      customerPaysCents: 6_901,
      totalCreditCents: 12_000,
      carrierName: 'CARRIER_SECRET',
      serviceName: 'SERVICE_SECRET',
      estimatedDeliveryDays: 3,
    };

    const shippingRequest = (
      overrides: Partial<HumanHandoffRequest> = {},
    ): HumanHandoffRequest => ({
      id: REF_ID,
      customerId: CUSTOMER,
      agentId: OPS,
      kind: 'shipping_approval',
      digest: { ...baseDigest },
      status: 'pending',
      resolution: null,
      createdAt: PIN,
      resolvedAt: null,
      ...overrides,
    });

    const st = (requestId: string | null = REF_ID): ConversationState => ({
      senderId: CUSTOMER,
      lastMessageAt: PIN,
      data:
        requestId === null
          ? {}
          : {
              pendingHumanRequest: {
                requestId,
                ref: `HF-${requestId}`,
                createdAt: PIN,
                customerNotifiedAt: PIN,
              },
            },
    });
    const prime = (target = shippingRequest()) => {
      conversationStore.get.mockResolvedValue(st());
      store.findLatestPendingForAgent.mockResolvedValue(target);
    };
    const run = (text: unknown, from = OPS) =>
      shipping.resolveReply({ text: text as string, from });
    const noWrites = () => {
      expect(store.resolve).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(conversationStore.clearPendingHumanRequest).not.toHaveBeenCalled();
    };

    beforeEach(() => {
      policy = {
        parseDecision: jest.fn<
          ShippingApprovalDecision | null,
          [value: unknown]
        >((value) => shippingApprovalPolicyAdapter.parseDecision(value)),
        verifyDraftPin: jest.fn<
          ShippingApprovalPinResult,
          [state: unknown, draftCreatedAt: string, nowMs: number]
        >(() => ({ kind: 'valid' })),
      };
      shipping = new HumanHandoffService(
        store,
        whatsappSender,
        conversationStore,
        configService,
        reservations,
        policy,
      );
    });

    it('pins the three ops replies byte-identically and leaks no forbidden data', () => {
      expect(SHIPPING_DECISION_GRAMMAR).toBe(
        'No pude interpretar tu decisión de envío. Responde con "APPROVE_SHIPPING" o "REJECT_SHIPPING" (opcionalmente con el código HF-xxxx de la solicitud antes de los dos puntos).',
      );
      expect(SHIPPING_REQUOTE_REPLY).toBe(
        'La cotización de envío ya no es válida. Se requiere una nueva cotización antes de continuar.',
      );
      expect(SHIPPING_RETRY_REPLY).toBe(
        'No pude procesar la respuesta del envío. Revisa la solicitud e inténtalo de nuevo.',
      );
      const leaked = [
        '6901',
        '69.01',
        '12000',
        '120.00',
        'CARRIER_SECRET',
        'SERVICE_SECRET',
        PIN,
        `HF-${REF_ID}`,
        CUSTOMER,
        OPS,
      ];
      for (const reply of [
        SHIPPING_DECISION_GRAMMAR,
        SHIPPING_REQUOTE_REPLY,
        SHIPPING_RETRY_REPLY,
      ]) {
        for (const token of leaked) expect(reply).not.toContain(token);
      }
    });

    it.each([
      ['wrong ref', 'HF-fffeeeddddcc: APPROVE_SHIPPING'],
      ['missing colon', `HF-${REF_ID} APPROVE_SHIPPING`],
      ['extra colon', `HF-${REF_ID}: APPROVE_SHIPPING: extra`],
      ['prose suffix', `HF-${REF_ID}: APPROVE_SHIPPING por favor`],
      ['reason suffix', `HF-${REF_ID}: APPROVE_SHIPPING porque sí`],
      ['prose prefix', `HF-${REF_ID}: autorizo APPROVE_SHIPPING`],
      ['multiple refs', `HF-${REF_ID}: APPROVE_SHIPPING HF-fffeeeddddcc`],
      ['embedded ref', `HF-${REF_ID}: APPROVE_SHIPPINGHF-fffeeeddddcc`],
      ['empty command', `HF-${REF_ID}: `],
      ['both commands', `HF-${REF_ID}: APPROVE_SHIPPING REJECT_SHIPPING`],
      ['unknown command', `HF-${REF_ID}: SHIP_IT`],
      ['tokenless prose', 'sí, adelante'],
    ])('%s → needs_decision with zero writes', async (label, text) => {
      prime();
      store.findByRef.mockResolvedValue(
        label === 'wrong ref' ? null : shippingRequest(),
      );
      expect(await run(text)).toEqual({
        kind: 'needs_decision',
        reply: SHIPPING_DECISION_GRAMMAR,
      });
      if (label === 'wrong ref') {
        expect(store.findLatestPendingForAgent).toHaveBeenCalledWith(OPS);
      }
      noWrites();
    });

    it.each([
      ['tokenless', '  approve_shipping  ', 'approve_shipping'],
      ['exact ref', `HF-${REF_ID}: REJECT_SHIPPING`, 'REJECT_SHIPPING'],
    ])(
      'valid %s command reaches fail-closed ops_error without writes',
      async (_label, text, command) => {
        prime();
        store.findByRef.mockResolvedValue(shippingRequest());
        // Full valid persistence is covered by the b3 suite.
        await run(text);
        expect(policy.parseDecision).toHaveBeenCalledWith(command);
        expect(policy.verifyDraftPin).toHaveBeenCalledTimes(1);
      },
    );

    it('rejects a coercible non-string as needs_decision with zero writes', async () => {
      prime();
      store.findByRef.mockResolvedValue(shippingRequest());
      expect(await run({ toString: () => 'APPROVE_SHIPPING' })).toEqual({
        kind: 'needs_decision',
        reply: SHIPPING_DECISION_GRAMMAR,
      });
      noWrites();
      expect(policy.parseDecision).not.toHaveBeenCalled();
    });

    it('never calls the policy for non-shipping requests', async () => {
      store.findByRef.mockResolvedValue({
        ...shippingRequest(),
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'x' },
      });
      conversationStore.get.mockResolvedValue(st());
      store.resolve.mockImplementation(async (id, resolution) => ({
        ...shippingRequest(),
        id,
        kind: 'out_of_stock',
        digest: { kind: 'out_of_stock', productId: 'p', name: 'x' },
        status: 'resolved',
        resolution,
        resolvedAt: PIN,
      }));
      const result = await run(`HF-${REF_ID} NO_RESTOCK`);
      expect(result.kind).toBe('resolved');
      expect(policy.parseDecision).not.toHaveBeenCalled();
    });

    const identityCases: Array<[string, Partial<HumanHandoffRequest>]> = [
      ['nonpending', { status: 'resolved' }],
      ['wrong stored agent', { agentId: '5215550001111' }],
      ['invalid id', { id: 'NOT-HEX-0000' }],
      [
        'wrong digest',
        { digest: { kind: 'out_of_stock', productId: 'p', name: 'x' } },
      ],
      [
        'invalid pin',
        { digest: { ...baseDigest, draftCreatedAt: 'HOSTILE_PIN' } },
      ],
    ];

    it.each(identityCases)(
      'guard %s → ops_error with zero writes and no policy parse',
      async (_label, over) => {
        store.findByRef.mockResolvedValue(shippingRequest(over));
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual({
          kind: 'ops_error',
          reply: SHIPPING_RETRY_REPLY,
        });
        noWrites();
        expect(policy.parseDecision).not.toHaveBeenCalled();
      },
    );

    it('guard wrong sender with a valid ref → ops_error, no parse, no writes', async () => {
      prime();
      store.findByRef.mockResolvedValue(shippingRequest());
      expect(
        await run(`HF-${REF_ID}: APPROVE_SHIPPING`, '5215550001111'),
      ).toEqual({ kind: 'ops_error', reply: SHIPPING_RETRY_REPLY });
      expect(policy.parseDecision).not.toHaveBeenCalled();
      noWrites();
    });

    it.each([
      ['missing marker', null],
      ['mismatched marker', 'ffffffffffff'],
    ])('guard %s → ops_error with zero writes', async (_label, requestId) => {
      conversationStore.get.mockResolvedValue(st(requestId));
      store.findByRef.mockResolvedValue(shippingRequest());
      expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual({
        kind: 'ops_error',
        reply: SHIPPING_RETRY_REPLY,
      });
      noWrites();
    });

    it('accepts a sandbox-normalized sender matching the assigned agent', async () => {
      const sandboxConfig = {
        get: (key: string) =>
          key === 'humanHandoff.opsChannelPhone'
            ? OPS
            : key === 'meta.sandboxRecipientNormalizationEnabled',
      } as unknown as ConfigService;
      const sandbox = new HumanHandoffService(
        store,
        whatsappSender,
        conversationStore,
        sandboxConfig,
        reservations,
        policy,
      );
      prime();
      store.findByRef.mockResolvedValue(
        shippingRequest({ agentId: '529999888777' }),
      );
      await sandbox.resolveReply({
        text: `HF-${REF_ID}: APPROVE_SHIPPING`,
        from: OPS,
      });
      expect(policy.parseDecision).toHaveBeenCalledWith('APPROVE_SHIPPING');
      expect(policy.verifyDraftPin).toHaveBeenCalledTimes(1);
    });

    describe('b2 stale-draft expiry', () => {
      const NOW = new Date('2026-06-23T12:05:00.000Z');
      // The port has no `draft_malformed`; the four non-valid verdicts are:
      const STALE_KINDS = [
        'invalid_clock',
        'draft_missing',
        'draft_expired',
        'draft_pin_mismatch',
      ] as const;

      const resolveRow = () =>
        store.resolve.mockImplementation(async (id, resolution) => ({
          ...shippingRequest(),
          id,
          status: 'resolved',
          resolution,
          resolvedAt: NOW.toISOString(),
        }));

      beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
        conversationStore.update.mockResolvedValue(st());
        conversationStore.clearPendingHumanRequest.mockResolvedValue(true);
      });
      afterEach(() => jest.useRealTimers());

      it.each(STALE_KINDS)(
        '%s → resolves SHIPPING_EXPIRED, request-ID-matched pending clear, no marker, needs_requote',
        async (kind) => {
          prime();
          store.findByRef.mockResolvedValue(shippingRequest());
          resolveRow();
          policy.verifyDraftPin.mockReturnValue({ kind });

          const result = await run(`HF-${REF_ID}: REJECT_SHIPPING`);

          expect(policy.verifyDraftPin).toHaveBeenCalledWith(
            st(),
            PIN,
            NOW.getTime(),
          );
          expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
            decision: 'SHIPPING_EXPIRED',
            draftCreatedAt: PIN,
            reason: kind,
          });
          expect(
            conversationStore.clearPendingHumanRequest,
          ).toHaveBeenCalledTimes(1);
          expect(
            conversationStore.clearPendingHumanRequest,
          ).toHaveBeenCalledWith(CUSTOMER, REF_ID);
          expect(store.resolve.mock.invocationCallOrder[0]).toBeLessThan(
            conversationStore.clearPendingHumanRequest.mock
              .invocationCallOrder[0],
          );
          expect(conversationStore.update).not.toHaveBeenCalled();
          expect(result).toEqual({
            kind: 'needs_requote',
            reply: SHIPPING_REQUOTE_REPLY,
          });
          expect(result).not.toHaveProperty('syntheticUserText');
        },
      );

      it('malformed grammar never reaches verifyDraftPin', async () => {
        prime();
        store.findByRef.mockResolvedValue(shippingRequest());
        expect(await run('sí, adelante')).toEqual({
          kind: 'needs_decision',
          reply: SHIPPING_DECISION_GRAMMAR,
        });
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
        noWrites();
      });

      it('wrong sender never verifies the pin', async () => {
        prime();
        store.findByRef.mockResolvedValue(shippingRequest());
        expect(
          await run(`HF-${REF_ID}: APPROVE_SHIPPING`, '5215550001111'),
        ).toEqual({ kind: 'ops_error', reply: SHIPPING_RETRY_REPLY });
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it.each(['null', 'reject'] as const)(
        'row resolve %s → ops_error and pending untouched',
        async (mode) => {
          prime();
          store.findByRef.mockResolvedValue(shippingRequest());
          policy.verifyDraftPin.mockReturnValue({ kind: 'draft_expired' });
          if (mode === 'null') store.resolve.mockResolvedValue(null);
          else store.resolve.mockRejectedValueOnce(new Error('db down'));
          expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual({
            kind: 'ops_error',
            reply: SHIPPING_RETRY_REPLY,
          });
          expect(conversationStore.update).not.toHaveBeenCalled();
          expect(
            conversationStore.clearPendingHumanRequest,
          ).not.toHaveBeenCalled();
        },
      );

      it.each(['false', 'reject'] as const)(
        'pending clear %s → ops_error, no needs_requote, no synthetic turn',
        async (mode) => {
          prime();
          store.findByRef.mockResolvedValue(shippingRequest());
          resolveRow();
          policy.verifyDraftPin.mockReturnValue({
            kind: 'draft_pin_mismatch',
          });
          if (mode === 'false') {
            conversationStore.clearPendingHumanRequest.mockResolvedValueOnce(
              false,
            );
          } else {
            conversationStore.clearPendingHumanRequest.mockRejectedValueOnce(
              new Error('db down'),
            );
          }
          const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
          expect(result).toEqual({
            kind: 'ops_error',
            reply: SHIPPING_RETRY_REPLY,
          });
          expect(result).not.toHaveProperty('syntheticUserText');
          expect(
            conversationStore.clearPendingHumanRequest,
          ).toHaveBeenCalledWith(CUSTOMER, REF_ID);
        },
      );
    });

    describe('b3 valid-decision persistence', () => {
      const NOW = new Date('2026-06-23T12:05:00.000Z');
      const DECIDED_AT = NOW.toISOString();

      const richState = (): ConversationState => ({
        senderId: CUSTOMER,
        lastMessageAt: PIN,
        data: {
          cart: { items: [{ sku: 'x' }], idempotencyKey: 'k' },
          placedSaleId: 'sale-1',
          pendingHumanRequest: {
            requestId: REF_ID,
            ref: `HF-${REF_ID}`,
            createdAt: PIN,
            customerNotifiedAt: PIN,
          },
        },
      });

      const setup = (
        updateOutcomes: Array<undefined | null | Error> = [
          undefined,
          undefined,
        ],
        resolveOutcome: undefined | null | Error = undefined,
      ): ConversationState => {
        const customerState = richState();
        conversationStore.get.mockResolvedValue(customerState);
        conversationStore.update.mockImplementation(async (senderId, patch) => {
          const next = updateOutcomes.shift();
          if (next instanceof Error) throw next;
          if (next === null) return null as unknown as ConversationState;
          return {
            senderId,
            lastMessageAt: patch.lastMessageAt ?? PIN,
            data: patch.data ?? {},
          };
        });
        conversationStore.clearPendingHumanRequest.mockResolvedValue(true);
        store.findByRef.mockResolvedValue(shippingRequest());
        policy.verifyDraftPin.mockReturnValue({ kind: 'valid' });
        store.resolve.mockImplementation(async (id, resolution) => {
          if (resolveOutcome instanceof Error) throw resolveOutcome;
          if (resolveOutcome === null) return null;
          return {
            ...shippingRequest(),
            id,
            status: 'resolved',
            resolution,
            resolvedAt: DECIDED_AT,
          };
        });
        return customerState;
      };

      beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
      });
      afterEach(() => jest.useRealTimers());

      it.each([
        ['APPROVE_SHIPPING', 'SHIPPING_APPROVED', 'aprobó'],
        ['REJECT_SHIPPING', 'SHIPPING_REJECTED', 'rechazó'],
      ] as const)(
        '%s → exact 4-field marker, row resolve, request-ID-matched pending clear, amount-free synthetic',
        async (command, decision, verb) => {
          const customerState = setup();

          const result = await run(`HF-${REF_ID}: ${command}`);

          expect(policy.verifyDraftPin).toHaveBeenCalledWith(
            customerState,
            PIN,
            NOW.getTime(),
          );
          const expectedMarker = {
            requestId: REF_ID,
            draftCreatedAt: PIN,
            decision,
            decidedAt: DECIDED_AT,
          };
          expect(conversationStore.update).toHaveBeenCalledTimes(1);
          expect(
            conversationStore.update.mock.calls[0][1].data?.shippingApproval,
          ).toEqual(expectedMarker);
          expect(
            conversationStore.update.mock.invocationCallOrder[0],
          ).toBeLessThan(store.resolve.mock.invocationCallOrder[0]);
          expect(store.resolve.mock.invocationCallOrder[0]).toBeLessThan(
            conversationStore.clearPendingHumanRequest.mock
              .invocationCallOrder[0],
          );
          expect(store.resolve).toHaveBeenCalledWith(REF_ID, {
            decision,
            draftCreatedAt: PIN,
          });
          expect(
            conversationStore.clearPendingHumanRequest,
          ).toHaveBeenCalledWith(CUSTOMER, REF_ID);

          expect(result.kind).toBe('resolved');
          if (result.kind !== 'resolved') throw new Error('expected resolved');
          expect(result.customerId).toBe(CUSTOMER);
          expect(result.ref).toBe(`HF-${REF_ID}`);
          expect(result.resolution).toEqual({
            decision,
            draftCreatedAt: PIN,
          });
          expect(result.syntheticUserText).toBe(
            `[Resolución del agente humano (HF-${REF_ID})] El agente ${verb} el envío.`,
          );
          for (const leaked of [
            '6901',
            '69.01',
            '12000',
            '120.00',
            'CARRIER_SECRET',
            'SERVICE_SECRET',
            PIN,
          ]) {
            expect(result.syntheticUserText).not.toContain(leaked);
          }
        },
      );

      it.each(['null', 'reject'] as const)(
        'marker write %s → ops_error with no row resolve and no pending clear',
        async (mode) => {
          setup([mode === 'null' ? null : new Error('db down')]);
          expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual({
            kind: 'ops_error',
            reply: SHIPPING_RETRY_REPLY,
          });
          expect(store.resolve).not.toHaveBeenCalled();
          expect(conversationStore.update).toHaveBeenCalledTimes(1);
          expect(
            conversationStore.clearPendingHumanRequest,
          ).not.toHaveBeenCalled();
        },
      );

      it.each(['null', 'reject'] as const)(
        'row resolve %s → compensation clear, ops_error, no synthetic, pending untouched',
        async (mode) => {
          setup(
            [undefined, undefined],
            mode === 'null' ? null : new Error('db down'),
          );
          const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
          expect(result).toEqual({
            kind: 'ops_error',
            reply: SHIPPING_RETRY_REPLY,
          });
          expect(result).not.toHaveProperty('syntheticUserText');
          const compensationPatch = conversationStore.update.mock.calls[1][1];
          expect(compensationPatch.data?.shippingApproval).toBeNull();
          expect(compensationPatch.data?.pendingHumanRequest).toMatchObject({
            requestId: REF_ID,
          });
          expect(
            conversationStore.clearPendingHumanRequest,
          ).not.toHaveBeenCalled();
        },
      );

      it('compensation rejection is swallowed → still ops_error', async () => {
        setup([undefined, new Error('comp down')], null);
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual({
          kind: 'ops_error',
          reply: SHIPPING_RETRY_REPLY,
        });
      });

      it.each(['false', 'reject'] as const)(
        'pending clear %s → ops_error with no synthetic turn',
        async (mode) => {
          setup();
          if (mode === 'false') {
            conversationStore.clearPendingHumanRequest.mockResolvedValueOnce(
              false,
            );
          } else {
            conversationStore.clearPendingHumanRequest.mockRejectedValueOnce(
              new Error('db down'),
            );
          }
          const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
          expect(result).toEqual({
            kind: 'ops_error',
            reply: SHIPPING_RETRY_REPLY,
          });
          expect(result).not.toHaveProperty('syntheticUserText');
          expect(conversationStore.update).toHaveBeenCalledTimes(1);
        },
      );
    });

    describe('b4c1 expired-row completion', () => {
      const EXPIRED_AT = '2026-06-23T12:05:00.000Z';
      const expiredRequest = (
        overrides: Partial<HumanHandoffRequest> = {},
      ): HumanHandoffRequest => ({
        ...shippingRequest(),
        status: 'resolved',
        resolution: {
          decision: 'SHIPPING_EXPIRED',
          draftCreatedAt: PIN,
          reason: 'draft_expired',
        },
        resolvedAt: EXPIRED_AT,
        ...overrides,
      });

      const primeExpired = (overrides: Partial<HumanHandoffRequest> = {}) => {
        store.findByRef.mockResolvedValue(expiredRequest(overrides));
        conversationStore.get.mockResolvedValue(st());
        conversationStore.clearPendingHumanRequest.mockResolvedValue(true);
      };

      // b4c1 must never resolve, update, or parse/verify a decision.
      const noCompletionWrites = () => {
        expect(store.resolve).not.toHaveBeenCalled();
        expect(conversationStore.update).not.toHaveBeenCalled();
        expect(policy.parseDecision).not.toHaveBeenCalled();
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      };
      const OPS_ERROR = {
        kind: 'ops_error',
        reply: SHIPPING_RETRY_REPLY,
      } as const;
      const REQUOTE = {
        kind: 'needs_requote',
        reply: SHIPPING_REQUOTE_REPLY,
      } as const;
      const noClear = () =>
        expect(
          conversationStore.clearPendingHumanRequest,
        ).not.toHaveBeenCalled();

      it('completes an expired row: clears the matching pending marker once and asks for requote', async () => {
        primeExpired();
        const result = await run(`HF-${REF_ID}: REJECT_SHIPPING`);
        expect(result).toEqual(REQUOTE);
        expect(conversationStore.clearPendingHumanRequest).toHaveBeenCalledWith(
          CUSTOMER,
          REF_ID,
        );
        noCompletionWrites();
      });

      it.each([
        ['absent ref', 'APPROVE_SHIPPING'],
        ['mismatched ref', 'HF-ffffffffffff: APPROVE_SHIPPING'],
        ['uppercase ref', `HF-${REF_ID.toUpperCase()}: APPROVE_SHIPPING`],
      ])('fails closed on %s without clearing', async (_label, text) => {
        store.findByRef.mockResolvedValue(expiredRequest());
        store.findLatestPendingForAgent.mockResolvedValue(expiredRequest());
        conversationStore.get.mockResolvedValue(st());
        expect(await run(text)).toEqual(OPS_ERROR);
        noClear();
        noCompletionWrites();
      });

      it('fails closed when the sender is not the assigned ops agent', async () => {
        primeExpired();
        expect(
          await run(`HF-${REF_ID}: APPROVE_SHIPPING`, '5215550001111'),
        ).toEqual(OPS_ERROR);
        noClear();
        noCompletionWrites();
      });

      it.each<[string, Partial<HumanHandoffRequest>]>([
        ['non-assigned stored agent', { agentId: '5215550001111' }],
        ['invalid target id', { id: 'NOT-HEX-0000' }],
        [
          'wrong digest kind',
          { digest: { kind: 'out_of_stock', productId: 'p', name: 'x' } },
        ],
        [
          'noncanonical digest pin',
          { digest: { ...baseDigest, draftCreatedAt: 'HOSTILE_PIN' } },
        ],
        ['malformed status', { status: 'garbage' as never }],
      ])('fails closed on %s without clearing', async (_label, over) => {
        primeExpired(over);
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual(OPS_ERROR);
        noClear();
        noCompletionWrites();
      });

      it.each([
        ['missing pending marker', st(null)],
        ['mismatched pending marker', st('ffffffffffff')],
      ])('fails closed on a %s without clearing', async (_label, state) => {
        store.findByRef.mockResolvedValue(expiredRequest());
        conversationStore.get.mockResolvedValue(state);
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual(OPS_ERROR);
        noClear();
        noCompletionWrites();
      });

      it.each<[string, HumanHandoffRequest['resolution']]>([
        ['null resolution', null],
        [
          'approved decision',
          { decision: 'SHIPPING_APPROVED', draftCreatedAt: PIN },
        ],
        [
          'rejected decision',
          { decision: 'SHIPPING_REJECTED', draftCreatedAt: PIN },
        ],
        [
          'mismatched pin',
          {
            decision: 'SHIPPING_EXPIRED',
            draftCreatedAt: '2026-06-23T11:00:00.000Z',
            reason: 'draft_expired',
          },
        ],
        [
          'invalid stale reason',
          {
            decision: 'SHIPPING_EXPIRED',
            draftCreatedAt: PIN,
            reason: 'whenever' as never,
          },
        ],
        [
          'extra key',
          {
            decision: 'SHIPPING_EXPIRED',
            draftCreatedAt: PIN,
            reason: 'draft_missing',
            extra: 1,
          } as never,
        ],
      ])('fails closed on %s without clearing', async (_label, resolution) => {
        primeExpired({ resolution });
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual(OPS_ERROR);
        noClear();
        noCompletionWrites();
      });

      it.each<[string, unknown, boolean]>([
        [
          'valid same-request',
          {
            requestId: REF_ID,
            draftCreatedAt: PIN,
            decision: 'SHIPPING_APPROVED',
            decidedAt: PIN,
          },
          false,
        ],
        ['malformed same-request', { requestId: REF_ID, junk: true }, false],
        [
          'valid sibling request',
          {
            requestId: 'ffffffffffff',
            draftCreatedAt: PIN,
            decision: 'SHIPPING_REJECTED',
            decidedAt: PIN,
          },
          true,
        ],
      ])(
        'approval marker %s → requote=%s',
        async (_label, shippingApproval, requote) => {
          primeExpired();
          conversationStore.get.mockResolvedValue({
            ...st(),
            data: { ...st().data, shippingApproval },
          });
          const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
          expect(result.kind).toBe(requote ? 'needs_requote' : 'ops_error');
          expect(
            conversationStore.clearPendingHumanRequest,
          ).toHaveBeenCalledTimes(requote ? 1 : 0);
          noCompletionWrites();
        },
      );

      it('contains a conversation get rejection as ops_error', async () => {
        store.findByRef.mockResolvedValue(expiredRequest());
        conversationStore.get.mockRejectedValueOnce(new Error('db down'));
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual(OPS_ERROR);
        noClear();
        noCompletionWrites();
      });

      it.each(['false', 'reject'] as const)(
        'conditional clear %s → ops_error with no synthetic turn',
        async (mode) => {
          primeExpired();
          if (mode === 'false') {
            conversationStore.clearPendingHumanRequest.mockResolvedValueOnce(
              false,
            );
          } else {
            conversationStore.clearPendingHumanRequest.mockRejectedValueOnce(
              new Error('db down'),
            );
          }
          const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
          expect(result).toEqual(OPS_ERROR);
          noCompletionWrites();
        },
      );

      it('is safe for concurrent retries: the winning clear completes, the loser emits no synthetic', async () => {
        primeExpired();
        conversationStore.clearPendingHumanRequest
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        const first = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
        const second = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
        expect(first).toEqual(REQUOTE);
        expect(second).toEqual(OPS_ERROR);
        expect(
          conversationStore.clearPendingHumanRequest,
        ).toHaveBeenCalledTimes(2);
        noCompletionWrites();
      });
    });

    describe('b4c2a rejected-row completion', () => {
      const DECIDED_AT = '2026-06-23T12:04:00.000Z';
      const NOW = new Date('2026-06-23T12:05:00.000Z');
      const OTHER_PIN = '2026-06-23T11:00:00.000Z';
      const OPS_ERROR = {
        kind: 'ops_error',
        reply: SHIPPING_RETRY_REPLY,
      } as const;
      const REQUOTE = {
        kind: 'needs_requote',
        reply: SHIPPING_REQUOTE_REPLY,
      } as const;

      const decidedRequest = (
        decision:
          | 'SHIPPING_APPROVED'
          | 'SHIPPING_REJECTED' = 'SHIPPING_REJECTED',
        resolution: unknown = { decision, draftCreatedAt: PIN },
      ): HumanHandoffRequest => ({
        ...shippingRequest(),
        status: 'resolved',
        resolution: resolution as never,
        resolvedAt: DECIDED_AT,
      });
      const goodMarker = (overrides: Record<string, unknown> = {}) => ({
        requestId: REF_ID,
        draftCreatedAt: PIN,
        decision: 'SHIPPING_REJECTED',
        decidedAt: DECIDED_AT,
        ...overrides,
      });
      const stateWith = (
        rawMarker: unknown,
        requestId: string | null = REF_ID,
      ): ConversationState => ({
        ...st(requestId),
        data: { ...st(requestId).data, shippingApproval: rawMarker },
      });
      const primeDecided = (rawMarker: unknown = goodMarker()) => {
        store.findByRef.mockResolvedValue(decidedRequest());
        conversationStore.get.mockResolvedValue(stateWith(rawMarker));
        conversationStore.clearPendingHumanRequest.mockResolvedValue(true);
      };
      // b4c2a must never resolve, update, or parse a new operator decision.
      const noReplay = () => {
        expect(store.resolve).not.toHaveBeenCalled();
        expect(conversationStore.update).not.toHaveBeenCalled();
        expect(policy.parseDecision).not.toHaveBeenCalled();
      };
      const closed = async (runner: () => Promise<unknown>) => {
        const result = await runner();
        expect(result).toEqual(OPS_ERROR);
        expect(result).not.toHaveProperty('syntheticUserText');
        expect(
          conversationStore.clearPendingHumanRequest,
        ).not.toHaveBeenCalled();
        noReplay();
      };

      beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
      afterEach(() => jest.useRealTimers());

      it('recovered rejection: the winning clear emits the persisted amount-free turn once', async () => {
        primeDecided();
        const result = await run(`HF-${REF_ID}: totally bogus`);
        expect(policy.verifyDraftPin).toHaveBeenCalledWith(
          stateWith(goodMarker()),
          PIN,
          NOW.getTime(),
        );
        expect(conversationStore.clearPendingHumanRequest).toHaveBeenCalledWith(
          CUSTOMER,
          REF_ID,
        );
        expect(result).toMatchObject({
          kind: 'resolved',
          customerId: CUSTOMER,
          ref: `HF-${REF_ID}`,
          resolution: { decision: 'SHIPPING_REJECTED', draftCreatedAt: PIN },
          syntheticUserText: `[Resolución del agente humano (HF-${REF_ID})] El agente rechazó el envío.`,
        });
        noReplay();
      });

      it.each([
        ['absent ref', 'APPROVE_SHIPPING', OPS],
        ['mismatched ref', 'HF-ffffffffffff: APPROVE_SHIPPING', OPS],
        ['uppercase ref', `HF-${REF_ID.toUpperCase()}: APPROVE_SHIPPING`, OPS],
        ['foreign sender', `HF-${REF_ID}: REJECT_SHIPPING`, '5215550001111'],
      ])('closes on a %s without clearing', async (_label, text, from) => {
        primeDecided();
        store.findLatestPendingForAgent.mockResolvedValue(decidedRequest());
        await closed(() => run(text, from));
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it.each<[string, unknown]>([
        ['null', null],
        ['missing key', { decision: 'SHIPPING_REJECTED' }],
        [
          'extra key',
          { decision: 'SHIPPING_REJECTED', draftCreatedAt: PIN, extra: 1 },
        ],
        ['non-decided', { decision: 'GENERIC', text: 'x' }],
        [
          'mismatched pin',
          { decision: 'SHIPPING_REJECTED', draftCreatedAt: OTHER_PIN },
        ],
      ])('closes on a %s persisted resolution', async (_label, resolution) => {
        primeDecided();
        store.findByRef.mockResolvedValue(
          decidedRequest('SHIPPING_REJECTED', resolution),
        );
        await closed(() => run(`HF-${REF_ID}: REJECT_SHIPPING`));
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it.each<[string, unknown, string | null]>([
        ['missing pending marker', goodMarker(), null],
        ['mismatched pending marker', goodMarker(), 'ffffffffffff'],
        ['missing marker', undefined, REF_ID],
        ['malformed marker', { requestId: REF_ID, junk: true }, REF_ID],
        [
          'marker wrong request',
          goodMarker({ requestId: 'ffffffffffff' }),
          REF_ID,
        ],
        ['marker wrong pin', goodMarker({ draftCreatedAt: OTHER_PIN }), REF_ID],
        [
          'marker wrong decision',
          goodMarker({ decision: 'SHIPPING_APPROVED' }),
          REF_ID,
        ],
      ])('closes on a %s without clearing', async (_label, raw, requestId) => {
        primeDecided();
        conversationStore.get.mockResolvedValue(stateWith(raw, requestId));
        await closed(() => run(`HF-${REF_ID}: REJECT_SHIPPING`));
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it('draft_expired clears once and re-quotes without a synthetic turn', async () => {
        primeDecided();
        policy.verifyDraftPin.mockReturnValue({ kind: 'draft_expired' });
        const result = await run(`HF-${REF_ID}: REJECT_SHIPPING`);
        expect(result).toEqual(REQUOTE);
        expect(result).not.toHaveProperty('syntheticUserText');
        expect(conversationStore.clearPendingHumanRequest).toHaveBeenCalledWith(
          CUSTOMER,
          REF_ID,
        );
        noReplay();
      });

      it.each([
        'invalid_clock',
        'draft_missing',
        'draft_pin_mismatch',
      ] as const)('closes on a %s verdict without clearing', async (kind) => {
        primeDecided();
        policy.verifyDraftPin.mockReturnValue({ kind });
        await closed(() => run(`HF-${REF_ID}: REJECT_SHIPPING`));
      });

      it.each([
        ['valid', 'false'],
        ['draft_expired', 'reject'],
      ] as const)(
        'closes when a %s verdict loses the %s clear',
        async (kind, mode) => {
          primeDecided();
          policy.verifyDraftPin.mockReturnValue({ kind });
          if (mode === 'false') {
            conversationStore.clearPendingHumanRequest.mockResolvedValueOnce(
              false,
            );
          } else {
            conversationStore.clearPendingHumanRequest.mockRejectedValueOnce(
              new Error('db down'),
            );
          }
          const result = await run(`HF-${REF_ID}: REJECT_SHIPPING`);
          expect(result).toEqual(OPS_ERROR);
          expect(result).not.toHaveProperty('syntheticUserText');
          noReplay();
        },
      );

      it('contains a store read rejection and a verifyDraftPin throw', async () => {
        primeDecided();
        conversationStore.get.mockRejectedValueOnce(new Error('db down'));
        await closed(() => run(`HF-${REF_ID}: REJECT_SHIPPING`));
        primeDecided();
        policy.verifyDraftPin.mockImplementation(() => {
          throw new Error('verify down');
        });
        await closed(() => run(`HF-${REF_ID}: REJECT_SHIPPING`));
      });

      it('is idempotent: the winner resolves once and the losing clear emits nothing', async () => {
        primeDecided();
        conversationStore.clearPendingHumanRequest
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        expect((await run(`HF-${REF_ID}: REJECT_SHIPPING`)).kind).toBe(
          'resolved',
        );
        expect(await run(`HF-${REF_ID}: REJECT_SHIPPING`)).toEqual(OPS_ERROR);
        expect(
          conversationStore.clearPendingHumanRequest,
        ).toHaveBeenCalledTimes(2);
        noReplay();
      });
    });

    describe('b4c2b approved-row completion', () => {
      const DECIDED_AT = '2026-06-23T12:04:00.000Z';
      const NOW = new Date('2026-06-23T12:05:00.000Z');
      const OTHER_PIN = '2026-06-23T11:00:00.000Z';
      const APPROVAL_TURN = `[Resolución del agente humano (HF-${REF_ID})] El agente aprobó el envío.`;
      const OPS_ERROR = {
        kind: 'ops_error',
        reply: SHIPPING_RETRY_REPLY,
      } as const;
      const REQUOTE = {
        kind: 'needs_requote',
        reply: SHIPPING_REQUOTE_REPLY,
      } as const;

      const approvedRequest = (
        resolution: unknown = {
          decision: 'SHIPPING_APPROVED',
          draftCreatedAt: PIN,
        },
      ): HumanHandoffRequest => ({
        ...shippingRequest(),
        status: 'resolved',
        resolution: resolution as never,
        resolvedAt: DECIDED_AT,
      });
      const goodMarker = (overrides: Record<string, unknown> = {}) => ({
        requestId: REF_ID,
        draftCreatedAt: PIN,
        decision: 'SHIPPING_APPROVED',
        decidedAt: DECIDED_AT,
        ...overrides,
      });
      const stateWith = (
        rawMarker: unknown,
        requestId: string | null = REF_ID,
      ): ConversationState => ({
        ...st(requestId),
        data: { ...st(requestId).data, shippingApproval: rawMarker },
      });
      const primeApproved = (rawMarker: unknown = goodMarker()) => {
        store.findByRef.mockResolvedValue(approvedRequest());
        conversationStore.get.mockResolvedValue(stateWith(rawMarker));
        conversationStore.clearPendingHumanRequest.mockResolvedValue(true);
      };
      // b4c2b must never resolve, update, or parse a new operator decision.
      const noReplay = () => {
        expect(store.resolve).not.toHaveBeenCalled();
        expect(conversationStore.update).not.toHaveBeenCalled();
        expect(policy.parseDecision).not.toHaveBeenCalled();
      };
      const closed = async (runner: () => Promise<unknown>) => {
        const result = await runner();
        expect(result).toEqual(OPS_ERROR);
        expect(result).not.toHaveProperty('syntheticUserText');
        expect(
          conversationStore.clearPendingHumanRequest,
        ).not.toHaveBeenCalled();
        noReplay();
      };

      beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
      afterEach(() => jest.useRealTimers());

      it('recovered approval: the winning clear emits the persisted amount-free turn once', async () => {
        primeApproved();
        const result = await run(`HF-${REF_ID}: totally bogus`);
        expect(policy.verifyDraftPin).toHaveBeenCalledWith(
          stateWith(goodMarker()),
          PIN,
          NOW.getTime(),
        );
        expect(conversationStore.clearPendingHumanRequest).toHaveBeenCalledWith(
          CUSTOMER,
          REF_ID,
        );
        expect(result).toEqual({
          kind: 'resolved',
          customerId: CUSTOMER,
          ref: `HF-${REF_ID}`,
          resolution: { decision: 'SHIPPING_APPROVED', draftCreatedAt: PIN },
          syntheticUserText: APPROVAL_TURN,
        });
        noReplay();
      });

      it('opposite REJECT_SHIPPING text does not overwrite the persisted approval', async () => {
        primeApproved();
        const result = await run(`HF-${REF_ID}: REJECT_SHIPPING`);
        expect(result).toMatchObject({
          kind: 'resolved',
          resolution: { decision: 'SHIPPING_APPROVED', draftCreatedAt: PIN },
          syntheticUserText: APPROVAL_TURN,
        });
        noReplay();
      });

      it('draft_expired clears once and re-quotes without a synthetic turn', async () => {
        primeApproved();
        policy.verifyDraftPin.mockReturnValue({ kind: 'draft_expired' });
        const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
        expect(result).toEqual(REQUOTE);
        expect(result).not.toHaveProperty('syntheticUserText');
        expect(conversationStore.clearPendingHumanRequest).toHaveBeenCalledWith(
          CUSTOMER,
          REF_ID,
        );
        noReplay();
      });

      it.each([
        'invalid_clock',
        'draft_missing',
        'draft_pin_mismatch',
      ] as const)('closes on a %s verdict without clearing', async (kind) => {
        primeApproved();
        policy.verifyDraftPin.mockReturnValue({ kind });
        await closed(() => run(`HF-${REF_ID}: APPROVE_SHIPPING`));
      });

      it.each([
        ['valid', 'false'],
        ['draft_expired', 'reject'],
      ] as const)(
        'closes when a %s verdict loses the %s clear',
        async (kind, mode) => {
          primeApproved();
          policy.verifyDraftPin.mockReturnValue({ kind });
          if (mode === 'false') {
            conversationStore.clearPendingHumanRequest.mockResolvedValueOnce(
              false,
            );
          } else {
            conversationStore.clearPendingHumanRequest.mockRejectedValueOnce(
              new Error('db down'),
            );
          }
          const result = await run(`HF-${REF_ID}: APPROVE_SHIPPING`);
          expect(result).toEqual(OPS_ERROR);
          expect(result).not.toHaveProperty('syntheticUserText');
          noReplay();
        },
      );

      it.each([
        ['absent ref', 'APPROVE_SHIPPING', OPS],
        ['mismatched ref', 'HF-ffffffffffff: APPROVE_SHIPPING', OPS],
        ['uppercase ref', `HF-${REF_ID.toUpperCase()}: APPROVE_SHIPPING`, OPS],
        ['foreign sender', `HF-${REF_ID}: APPROVE_SHIPPING`, '5215550001111'],
      ])('closes on a %s without clearing', async (_label, text, from) => {
        primeApproved();
        store.findLatestPendingForAgent.mockResolvedValue(approvedRequest());
        await closed(() => run(text, from));
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it.each<[string, unknown]>([
        ['null', null],
        ['missing key', { decision: 'SHIPPING_APPROVED' }],
        [
          'extra key',
          { decision: 'SHIPPING_APPROVED', draftCreatedAt: PIN, extra: 1 },
        ],
        ['non-decided', { decision: 'GENERIC', text: 'x' }],
        [
          'mismatched pin',
          { decision: 'SHIPPING_APPROVED', draftCreatedAt: OTHER_PIN },
        ],
      ])('closes on a %s persisted resolution', async (_label, resolution) => {
        primeApproved();
        store.findByRef.mockResolvedValue(approvedRequest(resolution));
        await closed(() => run(`HF-${REF_ID}: APPROVE_SHIPPING`));
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it.each<[string, unknown, string | null]>([
        ['missing pending marker', goodMarker(), null],
        ['mismatched pending marker', goodMarker(), 'ffffffffffff'],
        ['missing marker', undefined, REF_ID],
        ['malformed marker', { requestId: REF_ID, junk: true }, REF_ID],
        [
          'marker wrong request',
          goodMarker({ requestId: 'ffffffffffff' }),
          REF_ID,
        ],
        ['marker wrong pin', goodMarker({ draftCreatedAt: OTHER_PIN }), REF_ID],
        [
          'marker wrong decision',
          goodMarker({ decision: 'SHIPPING_REJECTED' }),
          REF_ID,
        ],
      ])('closes on a %s without clearing', async (_label, raw, requestId) => {
        primeApproved();
        conversationStore.get.mockResolvedValue(stateWith(raw, requestId));
        await closed(() => run(`HF-${REF_ID}: APPROVE_SHIPPING`));
        expect(policy.verifyDraftPin).not.toHaveBeenCalled();
      });

      it('contains a store read rejection and a verifyDraftPin throw', async () => {
        primeApproved();
        conversationStore.get.mockRejectedValueOnce(new Error('db down'));
        await closed(() => run(`HF-${REF_ID}: APPROVE_SHIPPING`));
        primeApproved();
        policy.verifyDraftPin.mockImplementation(() => {
          throw new Error('verify down');
        });
        await closed(() => run(`HF-${REF_ID}: APPROVE_SHIPPING`));
      });

      it('is idempotent: the winner resolves once and the losing clear emits nothing', async () => {
        primeApproved();
        conversationStore.clearPendingHumanRequest
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        expect((await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).kind).toBe(
          'resolved',
        );
        expect(await run(`HF-${REF_ID}: APPROVE_SHIPPING`)).toEqual(OPS_ERROR);
        expect(
          conversationStore.clearPendingHumanRequest,
        ).toHaveBeenCalledTimes(2);
        noReplay();
      });
    });
  });
});
