import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import {
  RECEIPT_UPLOAD_ERROR,
  type ReceiptUploadResponse,
} from '../../chatbot-api/domain/dtos/receipt-upload.dto';
import type {
  UploadCommitOutcome,
  ReceiptMediaStorePort,
} from '../domain/receipt-media-store.port';
import type { ReceiptExtraction } from '../domain/receipt-extraction.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  ReceiptAttachmentService,
  type UploadInvocation,
} from './receipt-attachment.service';

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const SALE_ID = '22222222-2222-4222-8222-222222222222';
const BACKEND_ID = '33333333-3333-4333-8333-333333333333';
const FENCE = { id: RECEIPT_ID, owner: 'owner-1', expectedVersion: '7' };
const BYTES = Buffer.from('receipt-bytes');

const receipt = {
  id: RECEIPT_ID,
  capturedSaleId: SALE_ID,
  providerMediaId: 'wa-media-1',
  declaredAmountCents: null,
} as unknown as ReceiptMediaRow;

const uploaded: ReceiptUploadResponse = {
  receiptId: BACKEND_ID,
  status: 'PENDING',
  mimeType: 'image/jpeg',
  sizeBytes: BYTES.length,
  sha256: 'ab'.repeat(32),
  previewStatus: 'READY',
};

const committed = { kind: 'committed' } as unknown as UploadCommitOutcome;

const fixture = () => {
  type Store = Pick<
    ReceiptMediaStorePort,
    | 'commitUploadSuccess'
    | 'commitUploadDefiniteFailure'
    | 'commitUploadUnknown'
  >;
  const store = {
    commitUploadSuccess: jest
      .fn<
        ReturnType<Store['commitUploadSuccess']>,
        Parameters<Store['commitUploadSuccess']>
      >()
      .mockResolvedValue(committed),
    commitUploadDefiniteFailure: jest
      .fn<
        ReturnType<Store['commitUploadDefiniteFailure']>,
        Parameters<Store['commitUploadDefiniteFailure']>
      >()
      .mockResolvedValue(committed),
    commitUploadUnknown: jest
      .fn<
        ReturnType<Store['commitUploadUnknown']>,
        Parameters<Store['commitUploadUnknown']>
      >()
      .mockResolvedValue(committed),
  };
  const client = {
    uploadReceipt: jest
      .fn<
        ReturnType<ChatbotApiClient['uploadReceipt']>,
        Parameters<ChatbotApiClient['uploadReceipt']>
      >()
      .mockResolvedValue(uploaded),
  };
  const service = new ReceiptAttachmentService(store, client);
  return { store, client, service };
};

const extracted = (
  overrides: Partial<Extract<ReceiptExtraction, { kind: 'receipt' }>> = {},
): ReceiptExtraction => ({
  kind: 'receipt',
  amountCents: 150000,
  date: '2026-11-05',
  reference: 'ABC123',
  bank: 'BBVA',
  confidence: 'high',
  amountMismatch: false,
  ...overrides,
});

const invocation = (
  overrides: Partial<UploadInvocation> = {},
): UploadInvocation => ({
  receipt,
  fence: FENCE,
  file: { bytes: BYTES, mimeType: 'image/jpeg' },
  extraction: extracted(),
  order: { saleId: SALE_ID, totalCents: 150000, folio: 'F-0042' },
  ...overrides,
});

describe('ReceiptAttachmentService.upload (R2)', () => {
  it('uploads the file with the extracted data and the media id as idempotency key', async () => {
    const { service, client, store } = fixture();
    const signal = new AbortController().signal;
    await expect(service.upload(invocation({ signal }))).resolves.toEqual({
      kind: 'uploaded',
      backendReceiptId: BACKEND_ID,
      outcome: committed,
    });
    expect(client.uploadReceipt).toHaveBeenCalledWith(
      SALE_ID,
      { bytes: BYTES, mimeType: 'image/jpeg', filename: 'receipt.jpg' },
      {
        extracted: {
          amountCents: 150000,
          date: '2026-11-05',
          reference: 'ABC123',
          bank: 'BBVA',
          confidence: 0.9,
        },
      },
      'wa-media-1',
      { signal },
    );
    expect(store.commitUploadSuccess).toHaveBeenCalledWith({
      ...FENCE,
      backendReceiptId: BACKEND_ID,
      templateArgs: { folio: 'F-0042' },
    });
  });

  it.each([
    ['medium', 0.6],
    ['low', 0.3],
  ] as const)('maps %s confidence to %d', async (confidence, value) => {
    const { service, client } = fixture();
    await service.upload(invocation({ extraction: extracted({ confidence }) }));
    expect(client.uploadReceipt.mock.calls[0][2]).toMatchObject({
      extracted: { confidence: value },
    });
  });

  it('sends the caption amount as declared, apart from the extraction (S4)', async () => {
    const { service, client } = fixture();
    await service.upload(
      invocation({
        receipt: { ...receipt, declaredAmountCents: 99900 },
        extraction: extracted({
          amountCents: null,
          date: null,
          reference: null,
          bank: null,
        }),
        file: { bytes: BYTES, mimeType: 'application/pdf' },
      }),
    );
    expect(client.uploadReceipt.mock.calls[0][1].filename).toBe('receipt.pdf');
    expect(client.uploadReceipt.mock.calls[0][2]).toEqual({
      declared: { amountCents: 99900 },
      extracted: { confidence: 0.9 },
    });
  });

  it('uploads without extracted data when the extraction is unavailable', async () => {
    const { service, client, store } = fixture();
    await service.upload(
      invocation({ extraction: { kind: 'unavailable', reason: 'timeout' } }),
    );
    expect(client.uploadReceipt.mock.calls[0][2]).toEqual({});
    expect(store.commitUploadSuccess.mock.calls[0][0].templateArgs).toEqual({
      folio: 'F-0042',
    });
  });

  it('passes both amounts to the received message on a mismatch, without blocking', async () => {
    const { service, store } = fixture();
    await service.upload(
      invocation({
        extraction: extracted({ amountCents: 140000, amountMismatch: true }),
      }),
    );
    expect(store.commitUploadSuccess.mock.calls[0][0].templateArgs).toEqual({
      folio: 'F-0042',
      extractedAmountCents: 140000,
      totalCents: 150000,
    });
  });

  it('omits the folio when the order does not carry one', async () => {
    const { service, store } = fixture();
    await service.upload(
      invocation({ order: { saleId: SALE_ID, totalCents: null, folio: null } }),
    );
    expect(store.commitUploadSuccess.mock.calls[0][0].templateArgs).toEqual({});
  });

  it.each([
    [409, RECEIPT_UPLOAD_ERROR.SALE_ALREADY_PAID, 'RECEIPT_SALE_ALREADY_PAID'],
    [409, RECEIPT_UPLOAD_ERROR.SALE_NOT_PAYABLE, 'RECEIPT_SALE_NOT_PAYABLE'],
    [413, RECEIPT_UPLOAD_ERROR.FILE_TOO_LARGE, 'RECEIPT_UNSUPPORTED_FORMAT'],
    [
      415,
      RECEIPT_UPLOAD_ERROR.FILE_TYPE_NOT_ALLOWED,
      'RECEIPT_UNSUPPORTED_FORMAT',
    ],
    [
      404,
      RECEIPT_UPLOAD_ERROR.SALE_NOT_FOUND,
      'RECEIPT_ATTACH_DEFINITE_FAILURE',
    ],
    [
      409,
      RECEIPT_UPLOAD_ERROR.IDEMPOTENCY_KEY_REUSED,
      'RECEIPT_ATTACH_DEFINITE_FAILURE',
    ],
    [
      400,
      RECEIPT_UPLOAD_ERROR.INVALID_FIELDS,
      'RECEIPT_ATTACH_DEFINITE_FAILURE',
    ],
    [
      400,
      RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED,
      'RECEIPT_ATTACH_DEFINITE_FAILURE',
    ],
    [
      400,
      RECEIPT_UPLOAD_ERROR.FILE_REQUIRED,
      'RECEIPT_ATTACH_DEFINITE_FAILURE',
    ],
    [
      400,
      RECEIPT_UPLOAD_ERROR.INVALID_IDEMPOTENCY_KEY,
      'RECEIPT_ATTACH_DEFINITE_FAILURE',
    ],
    [403, null, 'RECEIPT_ATTACH_DEFINITE_FAILURE'],
  ] as const)(
    'commits HTTP %i %s as a definite refusal with %s',
    async (httpStatus, errorCode, templateKey) => {
      const { service, client, store } = fixture();
      client.uploadReceipt.mockRejectedValue(
        new ChatbotApiError('refused', httpStatus, {}, errorCode),
      );
      await expect(service.upload(invocation())).resolves.toMatchObject({
        kind: 'refused',
        httpStatus,
      });
      expect(store.commitUploadDefiniteFailure).toHaveBeenCalledWith({
        ...FENCE,
        httpStatus,
        errorCode,
        templateKey,
        templateArgs: { folio: 'F-0042' },
      });
      expect(store.commitUploadUnknown).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      '502 RECEIPT_STORAGE_FAILED',
      new UpstreamError('x', 502, {}, RECEIPT_UPLOAD_ERROR.STORAGE_FAILED),
      { httpStatus: 502, transportCode: null },
    ],
    [
      'a 503',
      new UpstreamError('x', 503, {}, null),
      { httpStatus: 503, transportCode: null },
    ],
    [
      'a timeout',
      new UpstreamError('timeout', null, undefined, null),
      { httpStatus: null, transportCode: 'TRANSPORT_FAILURE' },
    ],
    [
      'an invalid 201 body',
      new UpstreamError('invalid', 201, {}, null),
      { httpStatus: null, transportCode: 'RESPONSE_INVALID' },
    ],
    [
      'an unexpected error',
      new Error('boom'),
      { httpStatus: null, transportCode: 'TRANSPORT_FAILURE' },
    ],
  ])(
    'treats %s as an unknown outcome retried later with the same key',
    async (_label, error, evidence) => {
      const { service, client, store } = fixture();
      client.uploadReceipt.mockRejectedValue(error);
      await expect(service.upload(invocation())).resolves.toMatchObject({
        kind: 'unknown',
      });
      expect(store.commitUploadUnknown).toHaveBeenCalledWith({
        ...FENCE,
        ...evidence,
      });
      expect(store.commitUploadDefiniteFailure).not.toHaveBeenCalled();
    },
  );

  it('treats an abort as an unknown outcome', async () => {
    const { service, client, store } = fixture();
    const controller = new AbortController();
    controller.abort();
    client.uploadReceipt.mockRejectedValue(
      new UpstreamError('canceled', null, undefined, null),
    );
    await service.upload(invocation({ signal: controller.signal }));
    expect(store.commitUploadUnknown).toHaveBeenCalledWith({
      ...FENCE,
      httpStatus: null,
      transportCode: 'ABORTED',
    });
  });
});
