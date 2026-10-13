import type { ConversationStore } from '../domain/conversation-store';
import type {
  MinimalCheckoutDraft,
  MinimalCheckoutDraftNewAddressChoice,
} from '../domain/minimal-checkout-draft';
import type { StoreFactory } from './conversation-store.contract';

export const CHECKOUT_SENDER = '5215512345678';
export const CHECKOUT_TIME = '2026-10-13T10:00:00.000Z';
const LATER = '2026-10-13T11:00:00.000Z';

export function checkoutDraft(
  revision = 0,
): MinimalCheckoutDraft & { address: MinimalCheckoutDraftNewAddressChoice } {
  return {
    schemaVersion: 1,
    senderId: CHECKOUT_SENDER,
    revision,
    sourceCustomerId: null,
    customer: { firstName: null, lastName: null },
    address: {
      kind: 'new',
      fields: {
        label: null,
        street: null,
        exteriorNumber: null,
        interiorNumber: null,
        zipCode: null,
        neighborhood: null,
        municipality: null,
        city: null,
        state: null,
        visualReferences: null,
        carrierPhone: null,
      },
    },
  };
}

// Run only for adapters that implement this optional public capability.
type CheckoutStore = ConversationStore &
  Required<Pick<ConversationStore, 'commitMinimalCheckoutDraft'>>;

export function runMinimalCheckoutDraftStoreContract(
  label: string,
  makeStore: StoreFactory,
): void {
  describe(`Minimal checkout draft store contract — ${label}`, () => {
    let store: CheckoutStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const built = await makeStore();
      store = built.store as CheckoutStore;
      cleanup = built.cleanup;
    });
    afterEach(async () => {
      await cleanup?.();
    });

    const commit = (expected: unknown, next: unknown, time = CHECKOUT_TIME) =>
      store.commitMinimalCheckoutDraft(CHECKOUT_SENDER, expected, next, time);

    it('creates on absent expectation and detaches the caller draft', async () => {
      const next = checkoutDraft();
      expect(await commit(undefined, next)).toBe(true);
      next.customer.firstName = 'caller mutation';
      expect(await store.get(CHECKOUT_SENDER)).toEqual({
        senderId: CHECKOUT_SENDER,
        lastMessageAt: CHECKOUT_TIME,
        data: { minimalCheckoutDraft: checkoutDraft() },
      });
    });

    it('does not create a row on a mismatched initial expectation', async () => {
      expect(await commit(null, checkoutDraft())).toBe(false);
      expect(await store.get(CHECKOUT_SENDER)).toBeNull();
    });

    it.each([null, { corrupt: true }])(
      'compares a present raw legacy slot without normalizing it: %p',
      async (raw) => {
        await store.create(CHECKOUT_SENDER, {
          lastMessageAt: CHECKOUT_TIME,
          data: { minimalCheckoutDraft: raw, sibling: 'kept' },
        });
        const before = await store.get(CHECKOUT_SENDER);
        expect(await commit(undefined, checkoutDraft(), LATER)).toBe(false);
        expect(await store.get(CHECKOUT_SENDER)).toEqual(before);
        expect(await commit(raw, checkoutDraft(), LATER)).toBe(true);
        expect(await store.get(CHECKOUT_SENDER)).toEqual({
          senderId: CHECKOUT_SENDER,
          lastMessageAt: LATER,
          data: { minimalCheckoutDraft: checkoutDraft(), sibling: 'kept' },
        });
      },
    );

    it('accepts a detached read expectation and preserves an exact saved snapshot', async () => {
      const saved: MinimalCheckoutDraft = {
        ...checkoutDraft(),
        sourceCustomerId: '00000000-0000-0000-0000-000000000000',
        address: {
          kind: 'saved',
          snapshot: {
            ...checkoutDraft().address.fields,
            id: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
            version: CHECKOUT_TIME,
            street: '',
          },
        },
      };
      expect(await commit(undefined, saved)).toBe(true);
      const read = (await store.get(CHECKOUT_SENDER))!;
      const next = { ...saved, revision: 1 };
      expect(await commit(read.data.minimalCheckoutDraft, next)).toBe(true);
      expect(
        (await store.get(CHECKOUT_SENDER))?.data.minimalCheckoutDraft,
      ).toEqual(next);
    });

    it('permits exactly one competing CAS and never retries a stale writer', async () => {
      await commit(undefined, checkoutDraft());
      const results = await Promise.all([
        commit(checkoutDraft(), checkoutDraft(1), LATER),
        commit(checkoutDraft(), checkoutDraft(2), LATER),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const before = await store.get(CHECKOUT_SENDER);
      expect(await commit(checkoutDraft(), checkoutDraft(3))).toBe(false);
      expect(await store.get(CHECKOUT_SENDER)).toEqual(before);
      expect(before?.data.minimalCheckoutDraft).toEqual(
        checkoutDraft(results[0] ? 1 : 2),
      );
    });

    it('preserves sibling state and the newer inbound timestamp', async () => {
      const siblings = {
        minimalCart: { items: [] },
        cart: { existing: true },
        restockDecision: { requestId: 'r' },
        expirationDecision: { requestId: 'e' },
        pendingHumanRequest: null,
        shippingApproval: { id: 's' },
        messages: [],
      };
      await store.create(CHECKOUT_SENDER, {
        lastMessageAt: LATER,
        data: siblings,
      });
      expect(await commit(undefined, checkoutDraft())).toBe(true);
      expect(await store.get(CHECKOUT_SENDER)).toEqual({
        senderId: CHECKOUT_SENDER,
        lastMessageAt: LATER,
        data: { ...siblings, minimalCheckoutDraft: checkoutDraft() },
      });
    });

    it.each([
      ['null next', CHECKOUT_SENDER, null, CHECKOUT_TIME],
      ['malformed next', CHECKOUT_SENDER, {}, CHECKOUT_TIME],
      [
        'foreign draft',
        CHECKOUT_SENDER,
        { ...checkoutDraft(), senderId: 'foreign' },
        CHECKOUT_TIME,
      ],
      ['blank sender', '', checkoutDraft(), CHECKOUT_TIME],
      ['blank timestamp', CHECKOUT_SENDER, checkoutDraft(), ''],
      ['invalid timestamp', CHECKOUT_SENDER, checkoutDraft(), 'not-a-time'],
    ])(
      'rejects %s without creating or changing state',
      async (_, sender, next, time) => {
        expect(
          await store.commitMinimalCheckoutDraft(sender, undefined, next, time),
        ).toBe(false);
        expect(await store.get(sender)).toBeNull();
        await store.create(sender, {
          lastMessageAt: CHECKOUT_TIME,
          data: { sibling: 'kept' },
        });
        const before = await store.get(sender);
        expect(
          await store.commitMinimalCheckoutDraft(sender, undefined, next, time),
        ).toBe(false);
        expect(await store.get(sender)).toEqual(before);
      },
    );

    it('legacy update cannot insert a checkout draft on absent rows or keys', async () => {
      const returned = await store.update(CHECKOUT_SENDER, {
        lastMessageAt: CHECKOUT_TIME,
        data: { minimalCheckoutDraft: checkoutDraft(), sibling: 'kept' },
      });
      expect(returned.data).toEqual({ sibling: 'kept' });
      expect(Object.hasOwn(returned.data, 'minimalCheckoutDraft')).toBe(false);
      await store.update(CHECKOUT_SENDER, {
        data: { minimalCheckoutDraft: checkoutDraft(), sibling: 'updated' },
      });
      expect((await store.get(CHECKOUT_SENDER))?.data).toEqual({
        sibling: 'updated',
      });
    });

    it('legacy stale and omitted patches preserve the current checkout value', async () => {
      await commit(undefined, checkoutDraft());
      const stale = (await store.get(CHECKOUT_SENDER))!;
      await commit(checkoutDraft(), checkoutDraft(1));
      await store.update(CHECKOUT_SENDER, {
        data: { ...stale.data, sibling: 'new' },
      });
      expect((await store.get(CHECKOUT_SENDER))?.data).toEqual({
        sibling: 'new',
        minimalCheckoutDraft: checkoutDraft(1),
      });
      await store.update(CHECKOUT_SENDER, { data: { sibling: 'omitted' } });
      expect((await store.get(CHECKOUT_SENDER))?.data).toEqual({
        sibling: 'omitted',
        minimalCheckoutDraft: checkoutDraft(1),
      });
    });

    it('cart and agent commits preserve the live checkout draft', async () => {
      await commit(undefined, checkoutDraft());
      const cart = { items: [], idempotencyKey: '', expectedTotalCents: 0 };
      expect(
        await store.commitMinimalCart!(
          CHECKOUT_SENDER,
          undefined,
          cart,
          CHECKOUT_TIME,
        ),
      ).toBe(true);
      expect(
        await store.commitAgentTurn(CHECKOUT_SENDER, {
          expected: { messages: [] },
          messages: [{ role: 'user', content: 'hello' }],
          catalogReferences: null,
          lastMessageAt: CHECKOUT_TIME,
        }),
      ).toBe(true);
      const state = (await store.get(CHECKOUT_SENDER))!;
      expect(state.data.minimalCheckoutDraft).toEqual(checkoutDraft());
      expect(state.data.minimalCart).toEqual(cart);
      expect(state.data.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(typeof state.data.agentRevision).toBe('string');
      expect(state.data.catalogReferences).toBeNull();
      expect(state.lastMessageAt).toBe(CHECKOUT_TIME);
    });

    it('returned get/create/update snapshots cannot rewrite an owned slot', async () => {
      const input = {
        lastMessageAt: CHECKOUT_TIME,
        data: { minimalCheckoutDraft: checkoutDraft(), sibling: 'kept' },
      };
      const created = await store.create(CHECKOUT_SENDER, input);
      input.data.minimalCheckoutDraft.customer.firstName = 'input mutation';
      (
        created.data.minimalCheckoutDraft as MinimalCheckoutDraft
      ).customer.lastName = 'return mutation';
      const fetched = (await store.get(CHECKOUT_SENDER))!;
      expect(fetched.data).toEqual({
        minimalCheckoutDraft: checkoutDraft(),
        sibling: 'kept',
      });
      delete fetched.data.minimalCheckoutDraft;
      fetched.lastMessageAt = LATER;
      const updated = await store.update(CHECKOUT_SENDER, {
        data: { sibling: 'new' },
      });
      (updated.data.minimalCheckoutDraft as MinimalCheckoutDraft).revision = 99;
      expect(await store.get(CHECKOUT_SENDER)).toEqual({
        senderId: CHECKOUT_SENDER,
        lastMessageAt: CHECKOUT_TIME,
        data: { minimalCheckoutDraft: checkoutDraft(), sibling: 'new' },
      });
    });

    it('returned wrappers cannot introduce an absent owned key', async () => {
      const input = {
        lastMessageAt: CHECKOUT_TIME,
        data: { sibling: 'kept' } as Record<string, unknown>,
      };
      const created = await store.create(CHECKOUT_SENDER, input);
      input.data.minimalCheckoutDraft = checkoutDraft();
      created.data.minimalCheckoutDraft = checkoutDraft();
      const fetched = (await store.get(CHECKOUT_SENDER))!;
      fetched.data.minimalCheckoutDraft = checkoutDraft();
      const updated = await store.update(CHECKOUT_SENDER, {
        lastMessageAt: CHECKOUT_TIME,
      });
      updated.data.minimalCheckoutDraft = checkoutDraft();
      expect(await store.get(CHECKOUT_SENDER)).toEqual({
        senderId: CHECKOUT_SENDER,
        lastMessageAt: CHECKOUT_TIME,
        data: { sibling: 'kept' },
      });
    });
  });
}
