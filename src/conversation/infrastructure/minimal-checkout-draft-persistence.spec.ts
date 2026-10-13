import { InMemoryConversationStore } from './in-memory-conversation.store';
import {
  CHECKOUT_SENDER,
  CHECKOUT_TIME,
  checkoutDraft,
  runMinimalCheckoutDraftStoreContract,
} from './minimal-checkout-draft-store.contract';

runMinimalCheckoutDraftStoreContract('memory', () =>
  Promise.resolve({ store: new InMemoryConversationStore() }),
);

describe('Minimal checkout memory ownership boundary', () => {
  it.each([undefined, null])(
    'keeps OWN %p through legacy updates',
    async (raw) => {
      const store = new InMemoryConversationStore();
      await store.create(CHECKOUT_SENDER, {
        lastMessageAt: CHECKOUT_TIME,
        data: { minimalCheckoutDraft: raw },
      });
      await store.update(CHECKOUT_SENDER, {
        data: { minimalCheckoutDraft: checkoutDraft(), sibling: 'kept' },
      });
      const state = (await store.get(CHECKOUT_SENDER))!;
      expect(Object.hasOwn(state.data, 'minimalCheckoutDraft')).toBe(true);
      expect(state.data.minimalCheckoutDraft).toBe(raw);
      expect(state.data.sibling).toBe('kept');
    },
  );

  it('does not treat OWN undefined as absent for CAS', async () => {
    const store = new InMemoryConversationStore();
    await store.create(CHECKOUT_SENDER, {
      lastMessageAt: CHECKOUT_TIME,
      data: { minimalCheckoutDraft: undefined, sibling: 'kept' },
    });
    const before = await store.get(CHECKOUT_SENDER);
    // Invoked through the public reusable suite until the optional port exists.
    const commit = (
      store as unknown as {
        commitMinimalCheckoutDraft(...args: unknown[]): Promise<boolean>;
      }
    ).commitMinimalCheckoutDraft.bind(store);
    expect(
      await commit(CHECKOUT_SENDER, undefined, checkoutDraft(), CHECKOUT_TIME),
    ).toBe(false);
    expect(await store.get(CHECKOUT_SENDER)).toEqual(before);
    expect(
      Object.hasOwn(
        (await store.get(CHECKOUT_SENDER))!.data,
        'minimalCheckoutDraft',
      ),
    ).toBe(true);
  });

  it('preserves unrelated nested reference identity on all public snapshots', async () => {
    const store = new InMemoryConversationStore();
    const sibling = {
      requestId: 'aaaa11112222',
      ref: 'HF-aaaa11112222',
      createdAt: CHECKOUT_TIME,
      customerNotifiedAt: CHECKOUT_TIME,
    };
    const created = await store.create(CHECKOUT_SENDER, {
      lastMessageAt: CHECKOUT_TIME,
      data: { pendingHumanRequest: sibling },
    });
    expect(created.data.pendingHumanRequest).toBe(sibling);
    expect((await store.get(CHECKOUT_SENDER))!.data.pendingHumanRequest).toBe(
      sibling,
    );
    const updated = await store.update(CHECKOUT_SENDER, {
      data: { step: 'new' },
    });
    expect(updated.data.pendingHumanRequest).toBe(sibling);
  });

  it('does not newly evaluate unrelated getters while storing or reading wrappers', async () => {
    const store = new InMemoryConversationStore();
    const read = jest.fn(() => {
      throw new Error('legacy getter');
    });
    const data = Object.defineProperty({}, 'legacy', {
      enumerable: true,
      get: read,
    });
    const created = await store.create(CHECKOUT_SENDER, {
      lastMessageAt: CHECKOUT_TIME,
      data,
    });
    const fetched = (await store.get(CHECKOUT_SENDER))!;
    expect(Object.getOwnPropertyDescriptor(created.data, 'legacy')?.get).toBe(
      read,
    );
    expect(Object.getOwnPropertyDescriptor(fetched.data, 'legacy')?.get).toBe(
      read,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses accessor checkout seeds without reading or inserting them', async () => {
    const store = new InMemoryConversationStore();
    const read = jest.fn(() => checkoutDraft());
    const data = Object.defineProperty({}, 'minimalCheckoutDraft', {
      enumerable: true,
      get: read,
    });
    await expect(
      store.create(CHECKOUT_SENDER, { lastMessageAt: CHECKOUT_TIME, data }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(await store.get(CHECKOUT_SENDER)).toBeNull();
  });

  it('refuses non-cloneable checkout seeds without replacing existing state', async () => {
    const store = new InMemoryConversationStore();
    await store.create(CHECKOUT_SENDER, {
      lastMessageAt: CHECKOUT_TIME,
      data: { sibling: 'kept' },
    });
    const before = await store.get(CHECKOUT_SENDER);
    await expect(
      store.create(CHECKOUT_SENDER, {
        lastMessageAt: CHECKOUT_TIME,
        data: { minimalCheckoutDraft: () => 'mutable closure' },
      }),
    ).rejects.toThrow();
    expect(await store.get(CHECKOUT_SENDER)).toEqual(before);
  });
});
