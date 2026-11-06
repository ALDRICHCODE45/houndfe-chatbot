import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { ChatbotApiError, UpstreamError } from '../domain/errors';
import {
  RECEIPT_UPLOAD_ERROR,
  RECEIPT_UPLOAD_TIMEOUT_MS,
  type ReceiptUploadResponse,
} from '../domain/dtos/receipt-upload.dto';
import { ChatbotApiHttpClient } from './chatbot-api-http.client';

const saleId = '11111111-1111-4111-8111-111111111111';
const file = {
  bytes: Buffer.from('%PDF-1.7 receipt'),
  mimeType: 'application/pdf' as const,
  filename: 'receipt.pdf',
};
const uploaded: ReceiptUploadResponse = {
  receiptId: 'receipt-1',
  status: 'PENDING',
  mimeType: 'application/pdf',
  sizeBytes: 16,
  sha256: 'ab'.repeat(32),
  previewStatus: 'READY',
};
const response = (data: unknown, status = 201) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
const httpError = (status: number, error?: string) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: error === undefined ? {} : { error } },
  });

describe('receipt upload mocked HTTP contract', () => {
  let request: jest.SpiedFunction<HttpService['request']>;
  let client: ChatbotApiHttpClient;
  beforeEach(() => {
    const http = new HttpService();
    request = jest
      .spyOn(http, 'request')
      .mockImplementation(() => throwError(() => new Error('unexpected HTTP')));
    client = new ChatbotApiHttpClient(
      http,
      new ConfigService({
        chatbotApi: {
          baseUrl: 'https://example.invalid',
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      jest.fn().mockResolvedValue(undefined),
    );
  });

  const sent = () => request.mock.calls[0][0];

  it('posts one multipart body with the media id as X-Idempotency-Key and a generous timeout', async () => {
    request.mockReturnValue(of(response(uploaded)));
    const signal = new AbortController().signal;
    await expect(
      client.uploadReceipt(
        saleId,
        file,
        {
          declared: { amountCents: 150000 },
          extracted: {
            amountCents: 149900,
            date: '2026-11-05',
            reference: 'ABC123',
            bank: 'BBVA',
            confidence: 0.9,
          },
        },
        'wamid-media-1',
        { signal },
      ),
    ).resolves.toEqual(uploaded);
    expect(request).toHaveBeenCalledTimes(1);
    const config = sent();
    expect(config).toMatchObject({
      method: 'POST',
      url: `/chatbot-api/sales/${saleId}/receipts`,
      baseURL: 'https://example.invalid',
      headers: {
        Authorization: 'Bearer svc_test',
        'X-Branch-Id': 'branch',
        'X-Idempotency-Key': 'wamid-media-1',
      },
      signal,
    });
    expect(config.timeout).toBe(RECEIPT_UPLOAD_TIMEOUT_MS);
    expect(RECEIPT_UPLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(75_000);
    const form = config.data as FormData;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get('file') as File;
    expect(part.name).toBe('receipt.pdf');
    expect(part.type).toBe('application/pdf');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(file.bytes);
    expect(form.get('declaredAmountCents')).toBe('150000');
    expect(form.has('declaredDate')).toBe(false);
    expect(form.has('declaredReference')).toBe(false);
    expect(JSON.parse(form.get('extracted') as string)).toEqual({
      amountCents: 149900,
      date: '2026-11-05',
      reference: 'ABC123',
      bank: 'BBVA',
      confidence: 0.9,
    });
  });

  it('sends only the file when nothing was declared or extracted', async () => {
    request.mockReturnValue(of(response(uploaded)));
    await client.uploadReceipt(saleId, file, {}, 'wamid-media-1');
    const form = sent().data as FormData;
    expect([...form.keys()]).toEqual(['file']);
  });

  it('reuses the same key for a retry of the same media', async () => {
    request
      .mockReturnValueOnce(
        throwError(() => httpError(502, 'RECEIPT_STORAGE_FAILED')),
      )
      .mockReturnValueOnce(of(response(uploaded)));
    await expect(
      client.uploadReceipt(saleId, file, {}, 'wamid-media-1'),
    ).rejects.toMatchObject({
      statusCode: 502,
      errorCode: RECEIPT_UPLOAD_ERROR.STORAGE_FAILED,
    });
    // One request per call: the client never retries a multipart POST itself.
    expect(request).toHaveBeenCalledTimes(1);
    await client.uploadReceipt(saleId, file, {}, 'wamid-media-1');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].headers).toMatchObject({
      'X-Idempotency-Key': 'wamid-media-1',
    });
  });

  it.each([
    [400, RECEIPT_UPLOAD_ERROR.INVALID_IDEMPOTENCY_KEY],
    [400, RECEIPT_UPLOAD_ERROR.FILE_REQUIRED],
    [400, RECEIPT_UPLOAD_ERROR.INVALID_FIELDS],
    [400, RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED],
    [404, RECEIPT_UPLOAD_ERROR.SALE_NOT_FOUND],
    [409, RECEIPT_UPLOAD_ERROR.SALE_NOT_PAYABLE],
    [409, RECEIPT_UPLOAD_ERROR.SALE_ALREADY_PAID],
    [409, RECEIPT_UPLOAD_ERROR.IDEMPOTENCY_KEY_REUSED],
    [413, RECEIPT_UPLOAD_ERROR.FILE_TOO_LARGE],
    [415, RECEIPT_UPLOAD_ERROR.FILE_TYPE_NOT_ALLOWED],
    [502, RECEIPT_UPLOAD_ERROR.STORAGE_FAILED],
  ])('surfaces HTTP %i %s as statusCode + errorCode', async (status, code) => {
    request.mockReturnValue(throwError(() => httpError(status, code)));
    const rejection = client.uploadReceipt(saleId, file, {}, 'wamid-media-1');
    await expect(rejection).rejects.toBeInstanceOf(ChatbotApiError);
    await expect(rejection).rejects.toMatchObject({
      statusCode: status,
      errorCode: code,
    });
  });

  it('keeps every contract code as a constant', () => {
    expect(Object.values(RECEIPT_UPLOAD_ERROR).sort()).toEqual(
      [
        'IDEMPOTENCY_KEY_REUSED',
        'INVALID_IDEMPOTENCY_KEY',
        'INVALID_RECEIPT_EXTRACTED',
        'INVALID_RECEIPT_FIELDS',
        'RECEIPT_FILE_REQUIRED',
        'RECEIPT_FILE_TOO_LARGE',
        'RECEIPT_FILE_TYPE_NOT_ALLOWED',
        'RECEIPT_STORAGE_FAILED',
        'SALE_ALREADY_PAID',
        'SALE_NOT_FOUND',
        'SALE_NOT_PAYABLE',
      ].sort(),
    );
  });

  it('maps a transport timeout to a status-less UpstreamError (unknown outcome)', async () => {
    request.mockReturnValue(
      throwError(() =>
        Object.assign(new Error('timeout of 90000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    );
    await expect(
      client.uploadReceipt(saleId, file, {}, 'wamid-media-1'),
    ).rejects.toMatchObject({ name: 'UpstreamError', statusCode: null });
  });

  it.each([
    ['a 200 status', response(uploaded, 200)],
    ['a missing receiptId', response({ ...uploaded, receiptId: '' })],
    ['a non-PENDING status', response({ ...uploaded, status: 'CONFIRMED' })],
    ['an unknown previewStatus', response({ ...uploaded, previewStatus: 'X' })],
    ['a negative size', response({ ...uploaded, sizeBytes: -1 })],
    ['a missing sha256', response({ ...uploaded, sha256: undefined })],
    ['an array body', response([uploaded])],
  ])('rejects %s as an invalid response', async (_label, reply) => {
    request.mockReturnValue(of(reply));
    await expect(
      client.uploadReceipt(saleId, file, {}, 'wamid-media-1'),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it.each([[''], ['x'.repeat(201)]])(
    'refuses an out-of-contract idempotency key before any HTTP',
    async (key) => {
      await expect(
        client.uploadReceipt(saleId, file, {}, key),
      ).rejects.toMatchObject({
        statusCode: 400,
        errorCode: RECEIPT_UPLOAD_ERROR.INVALID_IDEMPOTENCY_KEY,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );
});
