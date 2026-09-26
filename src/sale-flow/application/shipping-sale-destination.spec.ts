import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CustomerLookupResponse } from '../../chatbot-api/domain/dtos/customers.dto';
import {
  resolveShippingSaleDestination,
  type ShippingSalePinnedDestination,
} from './shipping-sale-destination';

// SQ-5E4 E4-1c: rematch the runtime sender against the pinned verdict, offline.
const CUSTOMER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ADDRESS = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const MODERN = '525512345678';
const LEGACY = '5215512345678';
const DEST = {
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};

type Over = Record<string, unknown>;

const pinned = (over: Over = {}): ShippingSalePinnedDestination => ({
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  destination: { ...DEST },
  ...over,
});

const address = (over: Over = {}) => ({
  id: ADDRESS,
  street: 'Calle Falsa 123',
  ...DEST,
  ...over,
});

const customer = (over: Over = {}) => ({
  customerId: CUSTOMER,
  firstName: 'Ana',
  phone: '5512345678',
  address: address(),
  ...over,
});

const lookup = (over: Over = {}): CustomerLookupResponse =>
  ({ found: true, customer: customer(), ...over }) as CustomerLookupResponse;

const withCustomer = (over: Over) => () => lookup({ customer: customer(over) });

const makeApi = (respond: () => unknown = () => lookup()) => {
  const calls: Array<{ cc: string; phone: string }> = [];
  const getCustomerByPhone = jest.fn(
    async (cc: string, phone: string): Promise<CustomerLookupResponse> => {
      calls.push({ cc, phone });
      return (await respond()) as CustomerLookupResponse;
    },
  );
  const api: Pick<ChatbotApiClient, 'getCustomerByPhone'> = {
    getCustomerByPhone,
  };
  return { api, getCustomerByPhone, calls };
};

describe('resolveShippingSaleDestination', () => {
  it('matches a modern 52 sender with one normalized lookup', async () => {
    const { api, calls } = makeApi();
    await expect(
      resolveShippingSaleDestination(MODERN, pinned(), api),
    ).resolves.toEqual({ kind: 'match' });
    expect(calls).toEqual([{ cc: '52', phone: '5512345678' }]);
  });

  it('normalizes a legacy 521 sender before the single lookup', async () => {
    const { api, calls } = makeApi();
    await expect(
      resolveShippingSaleDestination(LEGACY, pinned(), api),
    ).resolves.toEqual({ kind: 'match' });
    expect(calls).toEqual([{ cc: '52', phone: '5512345678' }]);
  });

  it('matches canonical UUIDs case-insensitively', async () => {
    const { api } = makeApi();
    const upper = pinned({
      customerId: CUSTOMER.toUpperCase(),
      shippingAddressId: ADDRESS.toUpperCase(),
    });
    await expect(
      resolveShippingSaleDestination(MODERN, upper, api),
    ).resolves.toEqual({ kind: 'match' });
  });

  it.each<[string, unknown]>([
    ['non-string', 525512345678],
    ['empty', ''],
    ['wrong country', '155512345678'],
    ['too short', '52551234567'],
    ['leading zero', '520551234567'],
    ['non-digit', '52ABC12345 6'],
  ])('fails closed with zero lookups for %s sender', async (_label, sender) => {
    const { api, getCustomerByPhone } = makeApi();
    await expect(
      resolveShippingSaleDestination(sender, pinned(), api),
    ).resolves.toEqual({ kind: 'blocked', reason: 'unsupported_sender' });
    expect(getCustomerByPhone).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown]>([
    [
      'synchronous throw',
      () => {
        throw new Error('backend secret 42');
      },
    ],
    [
      'rejected promise',
      async () => {
        throw new Error('backend secret 42');
      },
    ],
  ])(
    'fails closed on a %s lookup without leaking the error',
    async (_l, respond) => {
      const { api, getCustomerByPhone } = makeApi(respond);
      const result = await resolveShippingSaleDestination(
        MODERN,
        pinned(),
        api,
      );
      expect(result).toEqual({
        kind: 'blocked',
        reason: 'customer_lookup_failure',
      });
      expect(getCustomerByPhone).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('secret');
    },
  );

  it('fails closed on a hostile response without leaked detail', async () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'found', {
      get() {
        throw new Error('hostile trap');
      },
    });
    const { api } = makeApi(() => hostile);
    const result = await resolveShippingSaleDestination(MODERN, pinned(), api);
    expect(result).toEqual({ kind: 'blocked', reason: 'address_unavailable' });
    expect(Object.keys(result)).toEqual(['kind', 'reason']);
  });

  it('fails closed on a hostile pinned getter', async () => {
    const trapped = {
      ...pinned(),
      get customerId(): string {
        throw new Error('pinned trap');
      },
    };
    const { api, getCustomerByPhone } = makeApi();
    const result = await resolveShippingSaleDestination(MODERN, trapped, api);
    expect(result).toEqual({ kind: 'blocked', reason: 'address_unavailable' });
    expect(getCustomerByPhone).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('pinned trap');
  });

  it.each<[string, () => unknown]>([
    ['found false', () => lookup({ found: false, customer: null })],
    ['null customer', () => lookup({ customer: null })],
    ['missing address', withCustomer({ address: null })],
    ['non-plain response', () => []],
    ['customer id not UUID', withCustomer({ customerId: 'not-a-uuid' })],
    ['address id not UUID', withCustomer({ address: address({ id: 7 }) })],
    ['four-digit zip', withCustomer({ address: address({ zipCode: '6700' }) })],
    [
      'customer id newline suffix',
      withCustomer({ customerId: `${CUSTOMER}\n` }),
    ],
    [
      'address id newline suffix',
      withCustomer({ address: address({ id: `${ADDRESS}\n` }) }),
    ],
  ])('fails closed as address_unavailable for %s', async (_label, respond) => {
    const { api } = makeApi(respond);
    await expect(
      resolveShippingSaleDestination(MODERN, pinned(), api),
    ).resolves.toEqual({ kind: 'blocked', reason: 'address_unavailable' });
  });

  it.each<[string, Over]>([
    [
      'customer id drift',
      { customerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    ],
    [
      'address id drift',
      { address: address({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }) },
    ],
  ])('fails closed as identity_mismatch for %s', async (_label, over) => {
    const { api } = makeApi(withCustomer(over));
    await expect(
      resolveShippingSaleDestination(MODERN, pinned(), api),
    ).resolves.toEqual({ kind: 'blocked', reason: 'identity_mismatch' });
  });

  it.each<[string, Over]>([
    ['zip drift', { zipCode: '06701' }],
    ['state drift', { state: 'Jalisco' }],
    ['municipality drift', { municipality: 'Guadalajara' }],
    ['neighborhood drift', { neighborhood: 'Centro' }],
  ])('fails closed as destination_mismatch for %s', async (_label, drift) => {
    const { api } = makeApi(withCustomer({ address: address(drift) }));
    await expect(
      resolveShippingSaleDestination(MODERN, pinned(), api),
    ).resolves.toEqual({ kind: 'blocked', reason: 'destination_mismatch' });
  });

  it('returns a finite frozen no-PII match verdict', async () => {
    const { api } = makeApi();
    const result = await resolveShippingSaleDestination(MODERN, pinned(), api);
    expect(result).toEqual({ kind: 'match' });
    expect(Object.keys(result)).toEqual(['kind']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /5512345678|a1b2c3d4|Calle Falsa|Roma Norte/,
    );
  });
});
