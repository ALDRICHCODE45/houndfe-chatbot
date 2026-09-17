import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import type { AttachReceiptResponse } from '../../chatbot-api/domain/dtos/sales.dto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../../receipt-media/domain/receipt-media.types';
import type {
  AttachRequestStartOutcome,
  ReceiptMediaStorePort,
} from '../domain/receipt-media-store.port';
import { ReceiptAttachmentService } from './receipt-attachment.service';

const OWNER = 'lease-owner-1';
const BASE_URL = 'https://media.example.com';
const OBJECT_KEY = 'receipts/33333333-3333-4333-8333-333333333333';
const SALE_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const DURABLE_ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_PATTERN = /^[0-9a-f-]{36}$/;
const TRANSPORT_UNKNOWN = {
  httpStatus: null,
  transportCode: 'TRANSPORT_FAILURE',
};

type AttachableReceipt = ReceiptMediaRow & { declaredAmountCents: number };

const FAKE_INTENT: ReceiptMediaOutboxRow = {
  id: 'intent-1',
  dedupeKey: `receipt-attach-unknown:${RECEIPT_ID}:9:durable-wamid`,
  receiptMediaId: RECEIPT_ID,
  receiptStateVersion: '9',
  sourceWebhookMessageId: 'durable-wamid',
  recipientId: 'durable-sender',
  templateKey: 'RECEIPT_ATTACH_UNKNOWN',
  templateArgs: {},
  status: 'PENDING',
  attempts: 0,
  nextAttemptAt: new Date(0),
  leaseOwner: null,
  leaseExpiresAt: null,
  providerMessageId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  sentAt: null,
};

const FENCED_START: AttachRequestStartOutcome = { kind: 'fenced' };
// prettier-ignore
const CRASHED_START: AttachRequestStartOutcome = { kind: 'crashed-before-post', attachAttemptId: DURABLE_ATTEMPT_ID, version: '8', receipt: makeReceipt({ version: '8' }) };

// prettier-ignore
function makeReceipt(
  overrides: Partial<Omit<ReceiptMediaRow, 'declaredAmountCents'>> = {},
): AttachableReceipt {
  return { id: RECEIPT_ID, capturedSaleId: SALE_ID, objectKey: OBJECT_KEY, version: '7', declaredAmountCents: 15000, ...overrides } as AttachableReceipt;
}

type StoreKeys =
  | 'startAttachRequest'
  | 'commitAttachSuccess'
  | 'commitAttachDefiniteFailure'
  | 'commitAttachUnknownOutcome';

type StoreMock = jest.Mocked<Pick<ReceiptMediaStorePort, StoreKeys>>;
type ClientMock = jest.Mocked<Pick<ChatbotApiClient, 'attachReceipt'>>;

describe('ReceiptAttachmentService (WU11C)', () => {
  let store: StoreMock;
  let client: ClientMock;
  let service: ReceiptAttachmentService;

  beforeEach(() => {
    // prettier-ignore
    store = { startAttachRequest: jest.fn(), commitAttachSuccess: jest.fn(), commitAttachDefiniteFailure: jest.fn(), commitAttachUnknownOutcome: jest.fn() };
    client = { attachReceipt: jest.fn() };
    service = new ReceiptAttachmentService(store, client, {
      receiptMedia: { publicBaseUrl: BASE_URL },
    });
  });

  function arrangeStarted(): AttachableReceipt {
    // The durable successor deliberately differs from the caller row.
    // prettier-ignore
    const durable = { ...makeReceipt({ version: '8' }), capturedSaleId: 'dur-sale-1', objectKey: 'receipts/durable-key', declaredAmountCents: 9900 };
    store.startAttachRequest.mockResolvedValue({
      kind: 'started',
      version: '8',
      receipt: durable,
    });
    return makeReceipt();
  }

  function arrangeCommit(
    outcome: 'success' | 'definite' | 'unknown',
  ): AttachableReceipt {
    const receipt = arrangeStarted();
    if (outcome === 'success') {
      // prettier-ignore
      store.commitAttachSuccess.mockResolvedValue({ kind: 'committed', version: '9', receipt });
    } else if (outcome === 'definite') {
      // prettier-ignore
      store.commitAttachDefiniteFailure.mockResolvedValue({ kind: 'failed', version: '9', receipt });
    } else {
      // prettier-ignore
      store.commitAttachUnknownOutcome.mockResolvedValue({ kind: 'unknown', version: '9', receipt, intent: FAKE_INTENT });
    }
    return receipt;
  }

  function expectCommit(commit: StoreMock[StoreKeys], extra: object): void {
    const { attachAttemptId } = store.startAttachRequest.mock.calls[0][0];
    // prettier-ignore
    expect(commit).toHaveBeenCalledWith({ id: RECEIPT_ID, owner: OWNER, expectedVersion: '8', attachAttemptId, ...extra });
  }

  it('stamps start evidence before the single POST, posts only the started durable receipt data with the caller signal, and commits success with successor version and attempt id', async () => {
    const controller = new AbortController();
    const receipt = arrangeCommit('success');
    // prettier-ignore
    client.attachReceipt.mockResolvedValue({ receiptId: 'backend-r-1', status: 'PENDING' });
    await service.attach({
      receipt,
      owner: OWNER,
      signal: controller.signal,
    });
    const startArgs = store.startAttachRequest.mock.calls[0][0];
    // prettier-ignore
    expect(startArgs).toMatchObject({ id: RECEIPT_ID, owner: OWNER, expectedVersion: '7' });
    expect(startArgs.attachAttemptId).toMatch(UUID_PATTERN);
    expect(client.attachReceipt.mock.invocationCallOrder[0]).toBeGreaterThan(
      store.startAttachRequest.mock.invocationCallOrder[0],
    );
    expect(client.attachReceipt).toHaveBeenCalledTimes(1);
    const [saleId, body, options] = client.attachReceipt.mock.calls[0];
    expect(saleId).toBe('dur-sale-1');
    // prettier-ignore
    expect(body).toEqual({ mediaUrl: `${BASE_URL}/receipts/durable-key`, declaredAmountCents: 9900 });
    expect(options).toEqual({ signal: controller.signal });
    expect(store.commitAttachSuccess).toHaveBeenCalledTimes(1);
    // prettier-ignore
    expectCommit(store.commitAttachSuccess, { backendReceiptId: 'backend-r-1' });
    expect(store.commitAttachDefiniteFailure).not.toHaveBeenCalled();
    expect(store.commitAttachUnknownOutcome).not.toHaveBeenCalled();
  });

  it('a fenced start is a non-POST skip with zero transport or terminal calls', async () => {
    store.startAttachRequest.mockResolvedValue(FENCED_START);
    const report = await service.attach({
      receipt: makeReceipt(),
      owner: OWNER,
    });
    expect(report).toEqual({ kind: 'skipped', reason: 'fenced' });
    expect(client.attachReceipt).not.toHaveBeenCalled();
    expect(store.commitAttachSuccess).not.toHaveBeenCalled();
    expect(store.commitAttachDefiniteFailure).not.toHaveBeenCalled();
    expect(store.commitAttachUnknownOutcome).not.toHaveBeenCalled();
  });

  it('fixes a crashed-before-post reclaim forward with zero POSTs to one unknown commit using the durable attempt identity and version', async () => {
    store.startAttachRequest.mockResolvedValue(CRASHED_START);
    store.commitAttachUnknownOutcome.mockResolvedValue({
      kind: 'unknown',
      version: '9',
      receipt: makeReceipt({ version: '9' }),
      intent: FAKE_INTENT,
    });
    const report = await service.attach({
      receipt: makeReceipt(),
      owner: OWNER,
    });
    expect(report).toEqual({
      kind: 'outcome-unknown',
      httpStatus: null,
      transportCode: 'TRANSPORT_FAILURE',
    });
    expect(client.attachReceipt).not.toHaveBeenCalled();
    expect(store.commitAttachUnknownOutcome).toHaveBeenCalledTimes(1);
    expect(store.commitAttachUnknownOutcome).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '8',
      attachAttemptId: DURABLE_ATTEMPT_ID,
      httpStatus: null,
      transportCode: 'TRANSPORT_FAILURE',
    });
    expect(store.commitAttachSuccess).not.toHaveBeenCalled();
    expect(store.commitAttachDefiniteFailure).not.toHaveBeenCalled();
  });

  it('a fenced crashed-before-post fix-forward reports fence loss without a POST', async () => {
    store.startAttachRequest.mockResolvedValue(CRASHED_START);
    store.commitAttachUnknownOutcome.mockResolvedValue({ kind: 'fenced' });
    const report = await service.attach({
      receipt: makeReceipt(),
      owner: OWNER,
    });
    expect(report).toEqual({ kind: 'terminal-fenced' });
    expect(client.attachReceipt).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'HTTP %i commits a definite failure with that status only',
    async (status) => {
      const receipt = arrangeCommit('definite');
      // prettier-ignore
      client.attachReceipt.mockRejectedValue(new ChatbotApiError('rejected', status));
      const report = await service.attach({ receipt, owner: OWNER });
      expect(client.attachReceipt).toHaveBeenCalledTimes(1);
      expect(report).toEqual({ kind: 'definite-failure', httpStatus: status });
      expectCommit(store.commitAttachDefiniteFailure, { httpStatus: status });
      expect(store.commitAttachUnknownOutcome).not.toHaveBeenCalled();
      expect(store.commitAttachSuccess).not.toHaveBeenCalled();
    },
  );

  it.each([
    // prettier-ignore
    { status: 408, failure: new ChatbotApiError('boom', 408), response: null },
    // prettier-ignore
    { status: 500, failure: new ChatbotApiError('boom', 500), response: null },
    // prettier-ignore
    { status: null, failure: new Error('getaddrinfo EAI_AGAIN'), response: null },
    // prettier-ignore
    { status: null, failure: null, response: { receiptId: '', status: 'PENDING' } },
    // prettier-ignore
    { status: null, failure: null, response: { receiptId: 'r', status: 'CONFIRMED' } as unknown as AttachReceiptResponse },
  ] as {
    status: number | null;
    failure: Error | null;
    response: AttachReceiptResponse | null;
  }[])(
    'one POST then one unknown-outcome commit with exactly one evidence channel',
    async ({ status, failure, response }) => {
      const receipt = arrangeCommit('unknown');
      if (failure) {
        client.attachReceipt.mockRejectedValue(failure);
      } else {
        // prettier-ignore
        client.attachReceipt.mockResolvedValue(response as AttachReceiptResponse);
      }
      const report = await service.attach({ receipt, owner: OWNER });
      const transportCode = status === null ? 'TRANSPORT_FAILURE' : null;
      expect(client.attachReceipt).toHaveBeenCalledTimes(1);
      // prettier-ignore
      expect(report).toEqual({ kind: 'outcome-unknown', httpStatus: status, transportCode });
      expectCommit(store.commitAttachUnknownOutcome, {
        httpStatus: status,
        transportCode,
      });
      expect(store.commitAttachDefiniteFailure).not.toHaveBeenCalled();
      expect(store.commitAttachSuccess).not.toHaveBeenCalled();
    },
  );

  it('aborts: persists unknown evidence, then rethrows the same error', async () => {
    const controller = new AbortController();
    controller.abort();
    const receipt = arrangeCommit('unknown');
    const abortError = new DOMException('aborted', 'AbortError');
    client.attachReceipt.mockRejectedValue(abortError);
    await expect(
      service.attach({ receipt, owner: OWNER, signal: controller.signal }),
    ).rejects.toBe(abortError);
    expect(store.commitAttachUnknownOutcome).toHaveBeenCalledWith(
      expect.objectContaining(TRANSPORT_UNKNOWN),
    );
  });

  it('a fenced terminal commit reports fence loss without a second POST', async () => {
    arrangeStarted();
    store.commitAttachSuccess.mockResolvedValue({ kind: 'fenced' });
    // prettier-ignore
    client.attachReceipt.mockResolvedValue({ receiptId: 'backend-r-1', status: 'PENDING' });
    const report = await service.attach({
      receipt: makeReceipt(),
      owner: OWNER,
    });
    expect(report).toEqual({ kind: 'terminal-fenced' });
    expect(client.attachReceipt).toHaveBeenCalledTimes(1);
  });

  it('propagates start-store failures without transport calls or terminal writes', async () => {
    store.startAttachRequest.mockRejectedValue(new Error('db down'));
    await expect(
      service.attach({ receipt: makeReceipt(), owner: OWNER }),
    ).rejects.toThrow('db down');
    expect(client.attachReceipt).not.toHaveBeenCalled();
    expect(store.commitAttachSuccess).not.toHaveBeenCalled();
    expect(store.commitAttachDefiniteFailure).not.toHaveBeenCalled();
    expect(store.commitAttachUnknownOutcome).not.toHaveBeenCalled();
  });

  it('propagates terminal commit failures without retry or extra terminal writes', async () => {
    const receipt = arrangeCommit('success');
    // prettier-ignore
    client.attachReceipt.mockResolvedValue({ receiptId: 'backend-r-1', status: 'PENDING' });
    store.commitAttachSuccess.mockRejectedValue(new Error('db down'));
    await expect(service.attach({ receipt, owner: OWNER })).rejects.toThrow(
      'db down',
    );
    expect(store.commitAttachUnknownOutcome).not.toHaveBeenCalled();
    expect(store.commitAttachDefiniteFailure).not.toHaveBeenCalled();
  });
});
