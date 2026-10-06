import { classifyExpirationPreSend } from './expiration-pre-send-policy';

const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const BASE = Date.parse('2026-06-23T08:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const WITHIN = { action: 'within_windows' };
const HOLD = { action: 'hold' };
function fixture(
  variant = true,
  now = BASE,
  resolved = BASE - 3_600_000,
  inbound = BASE - 60_000,
) {
  return {
    senderId: 'customer',
    branchId: ' branch ',
    receivingPhoneNumberId: '123456',
    backendDecisionId: ID,
    now: iso(now),
    reservation: {
      senderId: 'customer',
      route: 'EXPIRATION',
      status: 'ACTIVE',
      requestKey: SOURCE,
      intake: {
        sourceRequestId: SOURCE,
        type: 'EXPIRATION',
        productId: ID,
        variantId: variant ? SOURCE : null,
      },
    },
    decision: {
      id: ID,
      sourceRequestId: SOURCE,
      type: 'EXPIRATION',
      status: 'RESOLVED',
      version: 2,
      createdAt: iso(resolved - 1000),
      supersedesDecisionId: null,
      applyBefore: iso(resolved + DAY),
      snapshot: {
        branchId: ' branch ',
        branchName: null,
        productId: ID,
        productName: 'Original food',
        unit: 'PZA',
        variantId: variant ? SOURCE : null,
        variantName: variant ? '3 kg' : null,
        variantOption: null,
        variantValue: null,
      },
      resolution: {
        action: 'PROVIDE_EXPIRATION_TEXT',
        expirationText: 'Marzo de 2027',
        resolvedAt: iso(resolved),
      },
    },
    latestInbound: {
      senderId: 'customer',
      receivingPhoneNumberId: '123456',
      messageId: 'later-wamid',
      providerTimestampSeconds: String(inbound / 1000),
      observedAt: iso(inbound),
    },
  };
}

describe('inactive EXPIRATION pre-send observation policy', () => {
  it.each([false, true])(
    'matches the original subject, variant=%s, without mutations',
    (variant) => {
      const input = fixture(variant);
      const before = JSON.stringify(input);
      const result = classifyExpirationPreSend(input);
      expect(result).toEqual(WITHIN);
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
      const unavailable = {
        ...input,
        decision: {
          ...input.decision,
          resolution: {
            action: 'REPORT_EXPIRATION_UNAVAILABLE',
            resolvedAt: input.decision.resolution.resolvedAt,
          },
        },
      };
      expect(classifyExpirationPreSend(unavailable)).toEqual(WITHIN);
    },
  );
  it.each([-1, 0, DAY - 1, DAY, DAY + 1])(
    'checks human-window offset %i with WhatsApp independently open',
    (offset) => {
      const now = BASE + offset;
      const inbound = Math.floor(now / 1000) * 1000 - 60_000;
      const input = fixture(true, now, BASE, inbound);
      expect(classifyExpirationPreSend(input)).toEqual(
        offset >= 0 && offset < DAY ? WITHIN : HOLD,
      );
    },
  );
  it.each([-1, 0, DAY - 1, DAY, DAY + 1])(
    'checks WhatsApp-window offset %i with human resolution independently fresh',
    (offset) => {
      const now = BASE + offset;
      const input = fixture(true, now, now - 60_000, BASE);
      expect(classifyExpirationPreSend(input)).toEqual(
        offset >= 0 && offset < DAY ? WITHIN : HOLD,
      );
    },
  );
  it('allows a later inbound to renew only the service window, never the inquiry or resolution', () => {
    const input = fixture(true, BASE, BASE - 1000, BASE - DAY);
    expect(classifyExpirationPreSend(input)).toEqual(HOLD);
    const original = JSON.stringify([input.reservation, input.decision]);
    input.latestInbound = {
      ...input.latestInbound,
      messageId: 'newer-browsing-wamid',
      providerTimestampSeconds: String((BASE - 1000) / 1000),
      observedAt: iso(BASE - 1000),
    };
    expect(classifyExpirationPreSend(input)).toEqual(WITHIN);
    expect(JSON.stringify([input.reservation, input.decision])).toBe(original);
    input.now = input.decision.applyBefore;
    input.latestInbound.providerTimestampSeconds = String(
      (Date.parse(input.now) - 1000) / 1000,
    );
    input.latestInbound.observedAt = iso(Date.parse(input.now) - 1000);
    expect(classifyExpirationPreSend(input)).toEqual(HOLD);
  });
  it.each([
    'sender',
    'branch',
    'request',
    'product',
    'variant',
    'backend',
    'inactive',
    'route',
    'inbound-sender',
    'phone',
    'configured-phone',
  ])('holds %s mismatch without normalizing identity', (field) => {
    const input = fixture();
    if (field === 'sender') input.reservation.senderId = 'other';
    if (field === 'branch') input.branchId = 'branch';
    if (field === 'request') input.reservation.requestKey = ID;
    if (field === 'product') input.decision.snapshot.productId = SOURCE;
    if (field === 'variant') input.decision.snapshot.variantId = ID;
    if (field === 'backend') input.backendDecisionId = SOURCE;
    if (field === 'inactive') input.reservation.status = 'CLOSED';
    if (field === 'route') input.reservation.route = 'RESTOCK';
    if (field === 'inbound-sender') input.latestInbound.senderId = 'customer ';
    if (field === 'phone')
      input.latestInbound.receivingPhoneNumberId = '654321';
    if (field === 'configured-phone') input.receivingPhoneNumberId = ' 123456';
    const before = JSON.stringify(input);
    expect(classifyExpirationPreSend(input)).toEqual(HOLD);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    '0',
    '-1',
    '01',
    '1.5',
    '1e9',
    ' 123',
    'NaN',
    'Infinity',
    '9007199254740992',
    '8640000000001',
  ])('holds invalid provider seconds %s', (seconds) => {
    const input = fixture();
    input.latestInbound.providerTimestampSeconds = seconds;
    expect(classifyExpirationPreSend(input)).toEqual(HOLD);
  });
  it.each([
    'clock',
    'observation',
    'future-observation',
    'observation-before-provider',
    'provider-future',
  ])('holds invalid or contradictory %s', (field) => {
    const input = fixture();
    if (field === 'clock') input.now = '2026-06-23T08:00:00Z';
    if (field === 'observation') input.latestInbound.observedAt = 'not-a-date';
    if (field === 'future-observation')
      input.latestInbound.observedAt = iso(BASE + 1);
    if (field === 'observation-before-provider')
      input.latestInbound.observedAt = iso(BASE - 60_001);
    if (field === 'provider-future')
      input.latestInbound.providerTimestampSeconds = String(
        (BASE + 1000) / 1000,
      );
    expect(classifyExpirationPreSend(input)).toEqual(HOLD);
  });
  it.each([
    '',
    ' ',
    ' padded',
    'a\nb',
    'a\u007fb',
    'a\u0085b',
    'x'.repeat(513),
  ])('holds unusable message identity: %#', (messageId) => {
    const input = fixture();
    input.latestInbound.messageId = messageId;
    expect(classifyExpirationPreSend(input)).toEqual(HOLD);
  });
  it.each([
    null,
    {},
    { ...fixture(), latestInbound: null },
    {
      ...fixture(),
      latestInbound: {
        ...fixture().latestInbound,
        sourceRequestId: SOURCE,
        version: 1,
      },
    },
    {
      ...fixture(),
      decision: {
        ...fixture().decision,
        status: 'PENDING',
        version: 1,
        resolution: null,
        applyBefore: null,
      },
    },
    {
      ...fixture(),
      latestInbound: {
        ...fixture().latestInbound,
        providerTimestampSeconds: BASE / 1000,
      },
    },
    {
      ...fixture(),
      latestInbound: {
        ...fixture().latestInbound,
        receivingPhoneNumberId: 'x',
      },
      receivingPhoneNumberId: 'x',
    },
    {
      ...fixture(),
      latestInbound: {
        ...fixture().latestInbound,
        receivingPhoneNumberId: '1'.repeat(25),
      },
      receivingPhoneNumberId: '1'.repeat(25),
    },
  ])(
    'holds malformed projections without fabricating eligibility: %#',
    (input) => {
      const result = classifyExpirationPreSend(input);
      expect(result).toEqual(HOLD);
      expect(Object.isFrozen(result)).toBe(true);
    },
  );
  it('takes a caller clock, not Date.now, and detaches the frozen classification', () => {
    const input = fixture();
    Object.freeze(input.latestInbound);
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('No ambient clock');
    });
    try {
      const result = classifyExpirationPreSend(input);
      expect(result).toEqual(WITHIN);
      input.now = iso(BASE + DAY);
      expect(result).toEqual(WITHIN);
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
