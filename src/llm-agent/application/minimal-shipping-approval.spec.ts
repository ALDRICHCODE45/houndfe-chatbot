import { ConfigService } from '@nestjs/config';
import { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import { shippingApprovalPolicyAdapter } from '../../shipping/application/shipping-approval-policy.adapter';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { buildMinimalShipping } from '../domain/minimal-shipping';
import {
  requestApproval,
  decideApproval,
  expireApproval,
  shippingDigest,
} from './minimal-shipping-approval';

const now = Date.parse('2026-06-22T00:00:00.000Z');
const id = 'abcdef123456';
async function setup(price = 1000) {
  const store = new InMemoryConversationStore();
  const shipping = buildMinimalShipping({
    quote: {
      kind: 'quoted',
      quoteId: 'q1',
      expiresAt: null,
      rates: [
        {
          rateId: 'r1',
          carrierName: 'Carrier',
          serviceName: 'Ground',
          priceCents: 10000,
          currency: 'MXN',
          estimatedDeliveryDays: 2,
          validUntil: null,
        },
      ],
    },
    cartLines: [
      {
        productId: '11111111-1111-4111-8111-111111111111',
        quantity: 1,
        unitPriceCents: price,
        finalPriceCents: price,
      },
    ],
    addressId: '22222222-2222-4222-8222-222222222222',
    addressVersion: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString(),
  })!;
  await store.create('customer', {
    lastMessageAt: new Date(now).toISOString(),
    data: {
      minimalCart: {
        items: shipping.cartLines.map(
          ({ productId, quantity, unitPriceCents }) => ({
            productId,
            quantity,
            unitPriceCents,
          }),
        ),
        idempotencyKey: '',
        shipping,
      },
      legacy: 'untouched',
    },
  });
  const handoff = {
    create: jest.fn(async () => {
      await store.setPendingHumanRequest(
        'customer',
        {
          requestId: id,
          ref: `HF-${id}`,
          createdAt: new Date(now).toISOString(),
          customerNotifiedAt: new Date(now).toISOString(),
        },
        new Date(now).toISOString(),
      );
      return {
        ok: true as const,
        requestId: id,
        ref: `HF-${id}`,
        customerNotified: true as const,
      };
    }),
  };
  return { store, shipping, handoff };
}

describe('minimal approval T4', () => {
  it.each([
    'APPROVE_SHIPPING',
    'REJECT_SHIPPING',
    'late',
    'conflict',
    'lazy-late',
  ] as const)(
    '[S1,S2,S7] existing ops resolver handles minimal %s',
    async (text) => {
      const h = await setup(50001);
      await requestApproval(h.store, h.handoff, 'customer', now);
      const target = {
        id,
        customerId: 'customer',
        agentId: 'ops',
        kind: 'shipping_approval' as const,
        digest: shippingDigest(h.shipping),
        status: 'pending' as const,
        resolution: null,
        createdAt: new Date(now).toISOString(),
        resolvedAt: null,
      };
      const rows = {
        create: jest.fn(),
        findById: jest.fn().mockResolvedValue(target),
        findByRef: jest.fn().mockResolvedValue(target),
        findLatestPendingForAgent: jest.fn(),
        resolve: jest.fn(
          (
            _id: string,
            resolution: import('../../human-handoff/domain/human-handoff.types').HumanHandoffResolution,
          ) =>
            Promise.resolve({
              ...target,
              status: 'resolved' as const,
              resolution,
            }),
        ),
      };
      const service = new HumanHandoffService(
        rows,
        { sendText: jest.fn() },
        h.store,
        {
          get: (key: string) =>
            key === 'humanHandoff.opsChannelPhone' ? 'ops' : true,
        } as unknown as ConfigService,
        {
          reserve: jest.fn(),
          closeLegacyResolved: jest.fn().mockResolvedValue(true),
        },
        shippingApprovalPolicyAdapter,
      );
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(
          text === 'late' || text === 'lazy-late' ? now + 1800000 : now + 1,
        );
      if (text === 'conflict')
        jest.spyOn(h.store, 'commitMinimalCart').mockResolvedValueOnce(false);
      if (text === 'lazy-late')
        expect(await service.expireMinimalShipping('customer')).toBe(true);
      try {
        const result = await service.resolveReply({
          from: 'ops',
          text: `HF-${id}: ${text === 'REJECT_SHIPPING' ? text : 'APPROVE_SHIPPING'}`,
        });
        if (text === 'conflict') {
          expect(result.kind).toBe('ops_error');
          expect(rows.resolve).not.toHaveBeenCalled();
          expect(
            (await h.store.get('customer'))!.data.pendingHumanRequest,
          ).toMatchObject({ requestId: id });
        } else {
          expect(result).toMatchObject(
            text === 'late' || text === 'lazy-late'
              ? { kind: 'needs_requote' }
              : {
                  kind: 'resolved',
                  minimalCustomerReply: expect.any(String) as unknown,
                },
          );
          expect(
            (await h.store.get('customer'))!.data.pendingHumanRequest,
          ).toBeNull();
          expect(rows.resolve).toHaveBeenCalledTimes(1);
        }
      } finally {
        jest.restoreAllMocks();
      }
    },
  );
  it.each([1000, 50001])(
    '[S1,S2,S4,S5] requests even zero charge; one exact-raw CAS, redacted digest',
    async (price) => {
      const h = await setup(price);
      const get = jest.spyOn(h.store, 'get');
      const cas = jest.spyOn(h.store, 'commitMinimalCart');
      expect(await requestApproval(h.store, h.handoff, 'customer', now)).toBe(
        true,
      );
      expect(cas).toHaveBeenCalledTimes(1);
      const first = (await get.mock.results[0].value) as Awaited<
        ReturnType<typeof h.store.get>
      >;
      expect(cas.mock.calls[0][1]).toBe(first!.data.minimalCart);
      expect(h.handoff.create).toHaveBeenCalledWith({
        senderId: 'customer',
        kind: 'shipping_approval',
        digest: shippingDigest(h.shipping),
      });
      expect(Object.keys(shippingDigest(h.shipping)).sort()).toEqual(
        [
          'kind',
          'draftCreatedAt',
          'customerPaysCents',
          'totalCreditCents',
          'carrierName',
          'serviceName',
          'estimatedDeliveryDays',
        ].sort(),
      );
      expect((await h.store.get('customer'))!.data.legacy).toBe('untouched');
    },
  );
  it.each([
    ['approved', 1000, '100.00'],
    ['approved', 50001, 'envío cubierto por su compra'],
    ['rejected', 1000, 'No se creó ningún pedido'],
  ] as const)(
    '[S1,S2,S7] %s sends deterministic message',
    async (state, price, fragment) => {
      const h = await setup(price);
      await requestApproval(h.store, h.handoff, 'customer', now);
      const result = await decideApproval(
        h.store,
        'customer',
        id,
        shippingDigest(h.shipping),
        state,
        now + 1,
      );
      expect(result?.state).toBe(state);
      expect(result?.reply).toContain(fragment);
      expect((await h.store.get('customer'))!.data.minimalCart).toMatchObject({
        shipping: { approval: { state, requestId: id } },
      });
    },
  );
  it('[S1,S4] mismatching pin, request and CAS conflict fail closed', async () => {
    const h = await setup();
    await requestApproval(h.store, h.handoff, 'customer', now);
    expect(
      await decideApproval(
        h.store,
        'customer',
        'other',
        shippingDigest(h.shipping),
        'approved',
        now + 1,
      ),
    ).toBeNull();
    expect(
      await decideApproval(
        h.store,
        'customer',
        id,
        {
          ...shippingDigest(h.shipping),
          draftCreatedAt: new Date(now + 1).toISOString(),
        },
        'approved',
        now + 1,
      ),
    ).toBeNull();
    jest.spyOn(h.store, 'commitMinimalCart').mockResolvedValueOnce(false);
    expect(
      await decideApproval(
        h.store,
        'customer',
        id,
        shippingDigest(h.shipping),
        'approved',
        now + 1,
      ),
    ).toBeNull();
  });
  it('[S6] late ops decision expires rather than approves', async () => {
    const h = await setup();
    await requestApproval(h.store, h.handoff, 'customer', now);
    expect(
      (
        await decideApproval(
          h.store,
          'customer',
          id,
          shippingDigest(h.shipping),
          'approved',
          now + 1800000,
        )
      )?.state,
    ).toBe('expired');
  });
  it('[S6] lazy expiry clears only matching pending and permits another inbound', async () => {
    const h = await setup();
    await requestApproval(h.store, h.handoff, 'customer', now);
    expect(await expireApproval(h.store, 'customer', now + 1799999)).toBe(
      false,
    );
    expect(await expireApproval(h.store, 'customer', now + 1800000)).toBe(true);
    expect(
      (await h.store.get('customer'))!.data.pendingHumanRequest,
    ).toBeNull();
    expect(await expireApproval(h.store, 'customer', now + 1800001)).toBe(
      false,
    );
  });
  it('[S6,S4] expiry never clears an unrelated human request', async () => {
    const h = await setup();
    await requestApproval(h.store, h.handoff, 'customer', now);
    await h.store.clearPendingHumanRequest('customer', id);
    await h.store.setPendingHumanRequest(
      'customer',
      {
        requestId: '111111111111',
        ref: 'HF-111111111111',
        createdAt: new Date(now).toISOString(),
        customerNotifiedAt: new Date(now).toISOString(),
      },
      new Date(now).toISOString(),
    );
    expect(await expireApproval(h.store, 'customer', now + 1800000)).toBe(
      false,
    );
    expect(
      (await h.store.get('customer'))!.data.pendingHumanRequest,
    ).toMatchObject({ requestId: '111111111111' });
  });
  it('[S1,S4] request CAS conflict fails closed and clears only its own marker', async () => {
    const h = await setup();
    jest.spyOn(h.store, 'commitMinimalCart').mockResolvedValueOnce(false);
    expect(await requestApproval(h.store, h.handoff, 'customer', now)).toBe(
      false,
    );
    expect(
      (await h.store.get('customer'))!.data.pendingHumanRequest,
    ).toBeNull();
    expect((await h.store.get('customer'))!.data.minimalCart).toMatchObject({
      shipping: { approval: { state: 'not_requested' } },
    });
  });
  it('[S6,S4] expiry CAS conflict never clears pending', async () => {
    const h = await setup();
    await requestApproval(h.store, h.handoff, 'customer', now);
    jest.spyOn(h.store, 'commitMinimalCart').mockResolvedValueOnce(false);
    expect(await expireApproval(h.store, 'customer', now + 1800000)).toBe(
      false,
    );
    expect(
      (await h.store.get('customer'))!.data.pendingHumanRequest,
    ).toMatchObject({ requestId: id });
  });
});
