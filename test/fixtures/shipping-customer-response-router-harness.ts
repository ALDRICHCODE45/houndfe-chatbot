/**
 * SCA-4b1 test-only harness for the router specs: the router-bound fake of the
 * narrow get/update seam plus `setup`/`route`/`failingConversations`. It is kept
 * out of the pure SCA-4b0 fixture so that fixture (and its spec) never import
 * the production router.
 */
import type { ConversationStateData } from '../../src/conversation/domain/conversation-store';
import {
  ShippingCustomerResponseRouter,
  type ShippingCustomerResponseConversations,
} from '../../src/shipping/application/shipping-customer-response-router';
import {
  NOW,
  base,
  input,
  stateOf,
  type Obj,
  type Patch,
} from './shipping-customer-response-router-fixture';

export const setup = (data: ConversationStateData | null, now = NOW) => {
  const updates: Patch[] = [];
  const conversations: ShippingCustomerResponseConversations = {
    get: jest.fn(async () => (data === null ? null : stateOf(data))),
    update: jest.fn(async (_senderId: string, patch: Patch) => {
      updates.push(patch);
      return stateOf(data ?? base());
    }),
  };
  return {
    router: new ShippingCustomerResponseRouter(conversations, () =>
      Date.parse(now),
    ),
    conversations,
    updates,
  };
};

export const route = async (
  data: ConversationStateData | null,
  over: Obj = {},
  now = NOW,
) => {
  const ctx = setup(data, now);
  const out = await ctx.router.route(input(over));
  return { ...ctx, out };
};

export const failingConversations = (
  where: 'get' | 'update',
  data: ConversationStateData | null,
): ShippingCustomerResponseConversations => ({
  get:
    where === 'get'
      ? jest.fn(async () => {
          throw new Error('read-boom');
        })
      : jest.fn(async () => (data === null ? null : stateOf(data))),
  update:
    where === 'update'
      ? jest.fn(async () => {
          throw new Error('write-boom');
        })
      : jest.fn(async (_senderId: string, patch: Patch) => {
          void patch;
          return stateOf(data ?? base());
        }),
});
