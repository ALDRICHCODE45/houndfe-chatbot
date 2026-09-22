import { ConfigService } from '@nestjs/config';
import type {
  ConversationStore,
  ConversationState,
} from '../../conversation/domain/conversation-store';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
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
  HumanHandoffService,
  formatResolutionAsUserTurn,
} from './human-handoff.service';
import { setPendingHumanRequest } from './pending-human-request-persistence';

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
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
    };

    configService = {
      get: (key: string) => {
        if (key === 'humanHandoff.enabled') return true;
        if (key === 'humanHandoff.opsChannelPhone') return OPS;
        return undefined;
      },
    } as unknown as ConfigService;

    service = new HumanHandoffService(
      store,
      whatsappSender,
      conversationStore,
      configService,
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

      expect(conversationStore.update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = conversationStore.update.mock.calls[0];
      expect(senderId).toBe(CUSTOMER);
      expect(patch).toMatchObject({
        lastMessageAt: now,
        data: {
          cart: prior.data.cart,
          pendingHumanRequest: {
            requestId: created.id,
            ref: `HF-${created.id}`,
            createdAt: now,
            customerNotifiedAt: now,
          },
        },
      });

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
      data: marker ? { pendingHumanRequest: marker } : {},
    });

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
      conversationStore.get.mockResolvedValue(
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
      expect(conversationStore.update).toHaveBeenCalledTimes(1);
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
      conversationStore.get.mockResolvedValue(
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
      conversationStore.get.mockResolvedValue(
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
    });

    it('no token + no pending: returns { kind: "no_pending", reply: ASK_FOR_REF }', async () => {
      store.findLatestPendingForAgent.mockResolvedValue(null);

      const result = await service.resolveReply({
        text: 'hola',
        from: OPS,
      });

      expect(result).toEqual({ kind: 'no_pending', reply: ASK_FOR_REF });
      expect(store.resolve).not.toHaveBeenCalled();
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
      conversationStore.get.mockResolvedValue(
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
      conversationStore.get.mockResolvedValue(
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
});

void setPendingHumanRequest;
