import { Logger } from '@nestjs/common';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import {
  RECEIPT_UPLOAD_ERROR,
  toReceiptUploadForm,
  type ReceiptUploadResponse,
} from '../../chatbot-api/domain/dtos/receipt-upload.dto';
import { LlmReceiptExtractionAdapter } from '../infrastructure/llm-receipt-extraction.adapter';
import type {
  UploadCommitOutcome,
  ReceiptMediaStorePort,
} from '../domain/receipt-media-store.port';
import type { ReceiptExtraction } from '../domain/receipt-extraction.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  ReceiptAttachmentService,
  toUploadFields,
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

const fixture = (
  options?: ConstructorParameters<typeof ReceiptAttachmentService>[2],
) => {
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
  const service = new ReceiptAttachmentService(store, client, options);
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
  destinationBank: null,
  destinationName: null,
  destinationAccountLast4: null,
  originName: null,
  confidence: 'high',
  amountMismatch: false,
  ...overrides,
});

/** The production retest receipt (N18). */
const DESTINATION = {
  destinationBank: 'BBVA MEXICO',
  destinationName: 'Abril Alejandra Vazquez Ramos',
  destinationAccountLast4: '9616',
  originName: 'Bryan Aldrich Flores',
} as const;
const DESTINATION_KEYS = Object.keys(DESTINATION);

/** Fields as the first attempt computes them from an extraction. */
const invocation = ({
  extraction = extracted(),
  ...overrides
}: Partial<UploadInvocation> & {
  extraction?: ReceiptExtraction;
} = {}): UploadInvocation => ({
  receipt: overrides.receipt ?? receipt,
  fence: FENCE,
  file: { bytes: BYTES, mimeType: 'image/jpeg' },
  fields: toUploadFields(overrides.receipt ?? receipt, extraction),
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

  it('sends persisted retry fields unchanged and derives the mismatch from them', async () => {
    const { service, client, store } = fixture();
    const fields = { extracted: { amountCents: 140000, confidence: 0.6 } };
    await service.upload(invocation({ fields }));
    expect(client.uploadReceipt.mock.calls[0][2]).toBe(fields);
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
    [422, null, 'RECEIPT_ATTACH_DEFINITE_FAILURE'],
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

  describe('follow-ups S7: a receipt on an expired pay-in-store hold', () => {
    const HOLD = {
      saleId: SALE_ID,
      totalCents: 150000,
      folio: 'F-0042',
      payInStoreHold: true,
    } as const;

    it('409 SALE_NOT_PAYABLE on a held order marks the notice as a hold expiry', async () => {
      const { service, client, store } = fixture();
      client.uploadReceipt.mockRejectedValue(
        new ChatbotApiError(
          'refused',
          409,
          {},
          RECEIPT_UPLOAD_ERROR.SALE_NOT_PAYABLE,
        ),
      );
      await service.upload(invocation({ order: HOLD }));
      expect(store.commitUploadDefiniteFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          templateKey: 'RECEIPT_SALE_NOT_PAYABLE',
          templateArgs: { folio: 'F-0042', payInStoreHold: true },
        }),
      );
    });

    it.each([
      [
        'another refusal of a held order',
        RECEIPT_UPLOAD_ERROR.SALE_ALREADY_PAID,
      ],
      ['an order without a hold', RECEIPT_UPLOAD_ERROR.SALE_NOT_PAYABLE],
    ])('%s keeps today’s args', async (name, code) => {
      const { service, client, store } = fixture();
      client.uploadReceipt.mockRejectedValue(
        new ChatbotApiError('refused', 409, {}, code),
      );
      await service.upload(
        name.startsWith('another') ? invocation({ order: HOLD }) : invocation(),
      );
      expect(
        store.commitUploadDefiniteFailure.mock.calls[0][0].templateArgs,
      ).toEqual({ folio: 'F-0042' });
    });

    it('an accepted upload of a held order carries no hold flag', async () => {
      const { service, store } = fixture();
      await service.upload(invocation({ order: HOLD }));
      expect(store.commitUploadSuccess.mock.calls[0][0].templateArgs).toEqual({
        folio: 'F-0042',
      });
    });
  });

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
    // Rate limiting and credential/config problems are fixable: retried.
    [
      'a 429 rate limit',
      new ChatbotApiError('rate limited', 429, {}, null),
      { httpStatus: 429, transportCode: null },
    ],
    [
      'a 401',
      new ChatbotApiError('unauthorized', 401, {}, null),
      { httpStatus: 401, transportCode: null },
    ],
    [
      'a 403',
      new ChatbotApiError('forbidden', 403, {}, null),
      { httpStatus: 403, transportCode: null },
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

  describe('destination fields (N18)', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    const invalidExtracted = (status: number) =>
      new ChatbotApiError(
        'refused',
        status,
        {},
        RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED,
      );
    const withDestination = () =>
      invocation({ extraction: extracted(DESTINATION) });
    const baseExtracted = {
      amountCents: 150000,
      date: '2026-11-05',
      reference: 'ABC123',
      bank: 'BBVA',
      confidence: 0.9,
    };

    it('maps only the read destination fields into the upload fields', () => {
      expect(
        toUploadFields(
          receipt,
          extracted({ destinationName: DESTINATION.destinationName }),
        ).extracted,
      ).toEqual({
        ...baseExtracted,
        destinationName: DESTINATION.destinationName,
      });
    });

    it('carries the production receipt destination into the multipart extracted part', async () => {
      const adapter = new LlmReceiptExtractionAdapter(
        jest.fn().mockResolvedValue({
          output: {
            isReceipt: true,
            amountCents: 38900,
            date: '2026-11-18',
            reference: 'MBAN01002611180012345678',
            bank: 'BBVA MEXICO',
            destinationBank: 'BBVA MEXICO',
            destinationName: 'Abril Alejandra Vazquez Ramos',
            destinationAccountLast4: '****9616',
            originName: 'Bryan Aldrich Flores',
            confidence: 'high',
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
        'gpt-test',
      );
      const extraction = await adapter.extract({
        bytes: BYTES,
        mimeType: 'image/jpeg',
        expectedAmountCents: 38900,
      });
      const form = toReceiptUploadForm(
        { bytes: BYTES, mimeType: 'image/jpeg', filename: 'receipt.jpg' },
        toUploadFields(receipt, extraction),
      );
      const raw = form.get('extracted') as string;
      expect(JSON.parse(raw)).toMatchObject({
        destinationBank: 'BBVA MEXICO',
        destinationName: 'Abril Alejandra Vazquez Ramos',
        destinationAccountLast4: '9616',
        originName: 'Bryan Aldrich Flores',
      });
      expect(raw).toContain('"destinationAccountLast4":"9616"');
    });

    it('sends the destination fields by default', async () => {
      const { service, client } = fixture();
      await service.upload(withDestination());
      expect(client.uploadReceipt.mock.calls[0][2]).toEqual({
        extracted: { ...baseExtracted, ...DESTINATION },
      });
    });

    it('sends none of them when RECEIPT_DESTINATION_FIELDS_ENABLED is false, retries included', async () => {
      const { service, client } = fixture({ destinationFieldsEnabled: false });
      await service.upload(withDestination());
      // A retry re-sends stored fields that still carry them.
      await service.upload(
        invocation({
          fields: { extracted: { ...DESTINATION, confidence: 0.6 } },
        }),
      );
      expect(client.uploadReceipt.mock.calls[0][2]).toEqual({
        extracted: baseExtracted,
      });
      expect(client.uploadReceipt.mock.calls[1][2]).toEqual({
        extracted: { confidence: 0.6 },
      });
    });

    it.each([400, 422])(
      'retries once without them, same key, when HTTP %i INVALID_RECEIPT_EXTRACTED refuses them',
      async (status) => {
        const { service, client, store } = fixture();
        client.uploadReceipt
          .mockRejectedValueOnce(invalidExtracted(status))
          .mockResolvedValueOnce(uploaded);
        await expect(service.upload(withDestination())).resolves.toEqual({
          kind: 'uploaded',
          backendReceiptId: BACKEND_ID,
          outcome: committed,
        });
        expect(client.uploadReceipt).toHaveBeenCalledTimes(2);
        const [first, second] = client.uploadReceipt.mock.calls;
        expect(first[2].extracted).toMatchObject(DESTINATION);
        expect(second[2]).toEqual({ extracted: baseExtracted });
        expect(second[3]).toBe('wa-media-1');
        expect(second[1]).toEqual(first[1]);
        expect(store.commitUploadDefiniteFailure).not.toHaveBeenCalled();
        expect(store.commitUploadSuccess).toHaveBeenCalledWith({
          ...FENCE,
          backendReceiptId: BACKEND_ID,
          templateArgs: { folio: 'F-0042' },
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String((warn.mock.calls as unknown[][])[0][0]);
        for (const key of DESTINATION_KEYS) expect(line).toContain(key);
        for (const value of Object.values(DESTINATION))
          expect(line).not.toContain(value);
        expect(line).not.toContain('BBVA');
      },
    );

    it('stores the stripped fields for later retries when the fallback outcome is unknown', async () => {
      const { service, client, store } = fixture();
      client.uploadReceipt
        .mockRejectedValueOnce(invalidExtracted(400))
        .mockRejectedValueOnce(new UpstreamError('x', 503, {}, null));
      await expect(service.upload(withDestination())).resolves.toMatchObject({
        kind: 'unknown',
      });
      expect(store.commitUploadUnknown).toHaveBeenCalledWith({
        ...FENCE,
        httpStatus: 503,
        transportCode: null,
        uploadFields: { extracted: baseExtracted },
      });
    });

    it('commits the fallback refusal as definite and never retries twice', async () => {
      const { service, client, store } = fixture();
      client.uploadReceipt
        .mockRejectedValueOnce(invalidExtracted(400))
        .mockRejectedValueOnce(invalidExtracted(400));
      await expect(service.upload(withDestination())).resolves.toMatchObject({
        kind: 'refused',
        httpStatus: 400,
      });
      expect(client.uploadReceipt).toHaveBeenCalledTimes(2);
      expect(store.commitUploadDefiniteFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED,
          templateKey: 'RECEIPT_ATTACH_DEFINITE_FAILURE',
        }),
      );
    });

    it.each([
      [
        'without destination fields',
        () => invocation(),
        400,
        RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED,
      ],
      [
        'for another 400 code',
        withDestination,
        400,
        RECEIPT_UPLOAD_ERROR.INVALID_FIELDS,
      ],
      [
        'for a 409',
        withDestination,
        409,
        RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED,
      ],
    ])('does not fall back %s', async (_label, build, status, code) => {
      const { service, client, store } = fixture();
      client.uploadReceipt.mockRejectedValue(
        new ChatbotApiError('refused', status, {}, code),
      );
      await service.upload(build());
      expect(client.uploadReceipt).toHaveBeenCalledTimes(1);
      expect(store.commitUploadDefiniteFailure).toHaveBeenCalledTimes(1);
    });
  });
});
