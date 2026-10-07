import { normalizeExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { prepareExpirationReply } from '../domain/expiration-reply-preparation';
import { createExpirationPreparationCandidate } from './expiration-preparation-candidate';
import { ExpirationDeliveryService } from './expiration-delivery.service';

const senderId = 'customer';
const branchId = 'branch';
const phone = '123456';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const productId = '44444444-4444-4444-8444-444444444444';
const sendToken = '11111111-1111-4111-8111-111111111111';
const resolvedAt = '2026-06-23T08:00:00.000Z';
const applyBefore = '2026-06-24T08:00:00.000Z';
const now = '2026-06-23T09:00:00.000Z';
const acceptedAt = '2026-06-23T09:00:05.000Z';
const beforeWindow = '2026-06-21T08:59:00.000Z';

function buildCandidate(productName = 'Original food') {
  const candidate = createExpirationPreparationCandidate(
    senderId,
    {
      outcome: 'resolved' as const,
      binding: {
        branchId,
        backendDecisionId: decisionId,
        postAttemptedAt: '2026-06-23T07:58:00.000Z',
        receiptRecordedAt: '2026-06-23T07:59:00.000Z',
        reservation: {
          status: 'ACTIVE' as const,
          route: 'EXPIRATION' as const,
          senderId,
          requestKey: sourceRequestId,
          intake: {
            sourceRequestId,
            type: 'EXPIRATION' as const,
            productId,
            variantId: null,
          },
        },
      },
      decision: {
        id: decisionId,
        sourceRequestId,
        type: 'EXPIRATION' as const,
        status: 'RESOLVED' as const,
        version: 2 as const,
        createdAt: resolvedAt,
        snapshot: {
          branchId,
          branchName: null,
          productId,
          productName,
          unit: 'PZA',
          variantId: null,
          variantName: null,
          variantOption: null,
          variantValue: null,
        },
        supersedesDecisionId: null,
        resolution: {
          action: 'PROVIDE_EXPIRATION_TEXT' as const,
          expirationText: 'Marzo de 2027',
          resolvedAt,
        },
        applyBefore,
      },
    },
    now,
  );
  if (candidate.action !== 'candidate') throw new Error('candidate fixture');
  return candidate;
}

const attemptId = deriveExpirationAttemptId(sourceRequestId, decisionId);
function startedRow() {
  const row = normalizeExpirationApplicationLedgerRow({
    state: 'SEND_STARTED',
    senderId,
    branchId,
    sourceRequestId,
    decisionId,
    resolutionVersion: 2,
    attemptId,
    resolvedAt,
    applyBefore,
    sendToken,
    attemptedAt: '2026-06-23T08:59:00.000Z',
  });
  if (!row || row.state !== 'SEND_STARTED') throw new Error('row fixture');
  return row;
}
function acceptedRow() {
  const row = normalizeExpirationApplicationLedgerRow({
    ...startedRow(),
    state: 'PROVIDER_ACCEPTED',
    providerMessageId: 'wamid.accepted',
    providerAcceptedObservedAt: acceptedAt,
  });
  if (!row || row.state !== 'PROVIDER_ACCEPTED') throw new Error('row fixture');
  return row;
}
function latest(providerIso = '2026-06-23T08:59:00.000Z') {
  return {
    kind: 'found' as const,
    observation: {
      senderId,
      receivingPhoneNumberId: phone,
      messageId: 'later-wamid',
      providerTimestampSeconds: String(Date.parse(providerIso) / 1000),
      observedAt: providerIso,
    },
  };
}

function setup() {
  const ports = {
    claimPending: jest.fn().mockResolvedValue({
      action: 'claimed',
      row: startedRow(),
    }),
    readLatest: jest.fn().mockResolvedValue(latest()),
    sendText: jest
      .fn()
      .mockResolvedValue({ providerMessageId: 'wamid.accepted' }),
    recordAcceptance: jest.fn().mockResolvedValue({
      action: 'updated',
      row: acceptedRow(),
    }),
  };
  let tick = 0;
  const clock = jest.fn(() => new Date(tick++ === 0 ? now : acceptedAt));
  const service = new ExpirationDeliveryService(ports, branchId, phone, clock);
  return { ports, clock, service };
}
type Harness = ReturnType<typeof setup>;

describe('dormant EXPIRATION delivery send boundary', () => {
  it('sends the original-subject copy once and records acceptance once', async () => {
    const h = setup();
    const candidate = buildCandidate();
    const copy = prepareExpirationReply(candidate.decision);
    if (copy.action !== 'prepared') throw new Error('copy fixture');
    const result = await h.service.deliverOnce(candidate);
    expect(h.ports.claimPending).toHaveBeenCalledTimes(1);
    expect(h.ports.claimPending).toHaveBeenCalledWith(candidate);
    expect(copy.text).toContain('Original food');
    expect(h.ports.sendText).toHaveBeenCalledTimes(1);
    expect(h.ports.sendText).toHaveBeenCalledWith({
      to: senderId,
      text: copy.text,
    });
    expect(h.ports.recordAcceptance).toHaveBeenCalledTimes(1);
    expect(h.ports.recordAcceptance).toHaveBeenCalledWith({
      row: startedRow(),
      event: {
        kind: 'provider_accepted',
        attemptId,
        sendToken,
        providerMessageId: 'wamid.accepted',
        providerAcceptedObservedAt: acceptedAt,
      },
    });
    expect(result).toEqual({ action: 'accepted', row: acceptedRow() });
    expect(h.clock).toHaveBeenCalledTimes(2);
  });

  it('holds unusable copy before claiming, without sending', async () => {
    const h = setup();
    const result = await h.service.deliverOnce(buildCandidate(''));
    expect(result).toEqual({ action: 'hold' });
    expect(h.ports.claimPending).not.toHaveBeenCalled();
    expect(h.ports.sendText).not.toHaveBeenCalled();
    expect(h.ports.recordAcceptance).not.toHaveBeenCalled();
  });

  const blockers: Array<[string, (h: Harness) => void, number]> = [
    [
      'a held claim',
      (h) => h.ports.claimPending.mockResolvedValue({ action: 'hold' }),
      0,
    ],
    [
      'missing latest inbound',
      (h) => h.ports.readLatest.mockResolvedValue({ kind: 'missing' }),
      1,
    ],
    [
      'unreadable latest inbound',
      (h) => h.ports.readLatest.mockResolvedValue({ kind: 'hold' }),
      1,
    ],
    [
      'a stale WhatsApp window',
      (h) => h.ports.readLatest.mockResolvedValue(latest(beforeWindow)),
      1,
    ],
    [
      'an expired human window',
      (h) => h.clock.mockReturnValue(new Date(applyBefore)),
      1,
    ],
    [
      'a claim bound to another decision',
      (h) =>
        h.ports.claimPending.mockResolvedValue({
          action: 'claimed',
          row: { ...startedRow(), decisionId: productId },
        }),
      0,
    ],
  ];
  it.each(blockers)(
    'holds and never sends on %s',
    async (_name, patch, reads) => {
      const h = setup();
      patch(h);
      const result = await h.service.deliverOnce(buildCandidate());
      expect(result).toEqual({ action: 'hold' });
      expect(h.ports.sendText).not.toHaveBeenCalled();
      expect(h.ports.recordAcceptance).not.toHaveBeenCalled();
      expect(h.ports.readLatest).toHaveBeenCalledTimes(reads);
    },
  );

  const ambiguities: Array<[string, (h: Harness) => void, boolean]> = [
    [
      'a thrown send',
      (h) => h.ports.sendText.mockRejectedValue(new Error('meta')),
      false,
    ],
    [
      'a held acceptance',
      (h) => h.ports.recordAcceptance.mockResolvedValue({ action: 'hold' }),
      true,
    ],
    [
      'a thrown acceptance',
      (h) => h.ports.recordAcceptance.mockRejectedValue(new Error('sql')),
      true,
    ],
  ];
  it.each(ambiguities)(
    'holds after exactly one attempt on %s, without retry',
    async (_name, patch, records) => {
      const h = setup();
      patch(h);
      const result = await h.service.deliverOnce(buildCandidate());
      expect(result).toEqual({ action: 'hold' });
      expect(h.ports.claimPending).toHaveBeenCalledTimes(1);
      expect(h.ports.sendText).toHaveBeenCalledTimes(1);
      expect(h.ports.recordAcceptance).toHaveBeenCalledTimes(records ? 1 : 0);
    },
  );

  it('samples the acceptance clock after the send, not the boundary clock', async () => {
    const h = setup();
    await h.service.deliverOnce(buildCandidate());
    const [[input]] = h.ports.recordAcceptance.mock.calls as unknown as [
      [{ event: { providerAcceptedObservedAt: string } }],
    ];
    expect(input.event.providerAcceptedObservedAt).toBe(acceptedAt);
    expect(input.event.providerAcceptedObservedAt).not.toBe(now);
  });
});
