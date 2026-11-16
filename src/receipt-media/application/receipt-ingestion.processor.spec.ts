import { Logger } from '@nestjs/common';
import type { ConversationState } from '../../conversation/domain/conversation-store';
import {
  MetaMediaError,
  type MetaMediaPort,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import type {
  ReceiptExtraction,
  ReceiptExtractionPort,
} from '../domain/receipt-extraction.port';
import {
  MAX_UPLOAD_ATTEMPTS,
  type ReceiptMediaStorePort,
  type UploadCommitOutcome,
} from '../domain/receipt-media-store.port';
import type {
  ReceiptMediaRow,
  ReceiptMimeType,
} from '../domain/receipt-media.types';
import type {
  ReceiptAttachmentService,
  UploadInvocation,
} from './receipt-attachment.service';
import { withMetaFailureReason } from '../infrastructure/meta-media-failure-reason';
import { MetaMediaClient } from '../infrastructure/meta-media.client';
import { ReceiptIngestionProcessor } from './receipt-ingestion.processor';

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const SALE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-1';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PDF = Buffer.from('%PDF-1.7\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const ENCRYPTED_PDF = Buffer.from(
  '%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 4 0 R >>\n%%EOF\n',
);
const committed = { kind: 'committed' } as unknown as UploadCommitOutcome;

const row = (overrides: Partial<ReceiptMediaRow> = {}): ReceiptMediaRow =>
  ({
    id: RECEIPT_ID,
    status: 'RESERVED',
    version: '3',
    senderId: '5215550000000',
    capturedSaleId: SALE_ID,
    providerMediaId: 'wa-media-1',
    declaredMimeType: 'image/jpeg',
    declaredAmountCents: null,
    metaAttempts: 0,
    storageAttempts: 0,
    ...overrides,
  }) as ReceiptMediaRow;

const state = (placedSale: unknown): ConversationState =>
  ({
    data: { minimalCart: { items: [], placedSale } },
  }) as unknown as ConversationState;

const receiptExtraction: ReceiptExtraction = {
  kind: 'receipt',
  amountCents: 150000,
  date: null,
  reference: null,
  bank: null,
  confidence: 'high',
  amountMismatch: false,
};

type Store = Pick<
  ReceiptMediaStorePort,
  | 'startMetaAttempt'
  | 'startStorageAttempt'
  | 'commitDownload'
  | 'commitMetaFailureDisposition'
  | 'commitUploadUnknown'
  | 'commitRejectedMedia'
  | 'renewLease'
>;

const fixture = (
  options: {
    bytes?: Buffer;
    mime?: ReceiptMimeType;
    extraction?: ReceiptExtraction;
    download?: () => Promise<ValidatedMediaFile>;
    placedSale?: unknown;
  } = {},
) => {
  const bytes = options.bytes ?? JPEG;
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const file: ValidatedMediaFile = {
    filePath: '/tmp/receipt',
    mimeType: options.mime ?? 'image/jpeg',
    byteCount: bytes.length,
    providerDeclaredBytes: bytes.length,
    sha256: Buffer.alloc(32, 1),
    cleanup,
  };
  const resolveAndDownload = jest.fn<
    ReturnType<MetaMediaPort['resolveAndDownload']>,
    Parameters<MetaMediaPort['resolveAndDownload']>
  >(options.download ?? (() => Promise.resolve(file)));
  const store = {
    startMetaAttempt: jest.fn<
      ReturnType<Store['startMetaAttempt']>,
      Parameters<Store['startMetaAttempt']>
    >(() => Promise.resolve({ attempt: 1, version: '4' })),
    commitDownload: jest.fn<
      ReturnType<Store['commitDownload']>,
      Parameters<Store['commitDownload']>
    >(() => Promise.resolve({ kind: 'committed' })),
    startStorageAttempt: jest.fn<
      ReturnType<Store['startStorageAttempt']>,
      Parameters<Store['startStorageAttempt']>
    >((fence) =>
      Promise.resolve({
        attempt: 1,
        version: String(Number(fence.expectedVersion) + 1),
      }),
    ),
    commitMetaFailureDisposition: jest.fn<
      ReturnType<Store['commitMetaFailureDisposition']>,
      Parameters<Store['commitMetaFailureDisposition']>
    >(() => Promise.resolve({ kind: 'fenced' })),
    commitUploadUnknown: jest.fn<
      ReturnType<Store['commitUploadUnknown']>,
      Parameters<Store['commitUploadUnknown']>
    >(() => Promise.resolve(committed)),
    commitRejectedMedia: jest.fn<
      ReturnType<Store['commitRejectedMedia']>,
      Parameters<Store['commitRejectedMedia']>
    >(() => Promise.resolve(committed)),
    renewLease: jest.fn<
      ReturnType<Store['renewLease']>,
      Parameters<Store['renewLease']>
    >(() => Promise.resolve(true)),
  };
  const extract = jest.fn<
    ReturnType<ReceiptExtractionPort['extract']>,
    Parameters<ReceiptExtractionPort['extract']>
  >(() => Promise.resolve(options.extraction ?? receiptExtraction));
  const upload = jest.fn<
    ReturnType<ReceiptAttachmentService['upload']>,
    [UploadInvocation]
  >(() =>
    Promise.resolve({
      kind: 'uploaded',
      backendReceiptId: 'b',
      outcome: committed,
    }),
  );
  const conversations = {
    get: jest.fn(() =>
      Promise.resolve(
        state(
          'placedSale' in options
            ? options.placedSale
            : { saleId: SALE_ID, folio: 'F-7', totalCents: 150000 },
        ),
      ),
    ),
  };
  const processor = new ReceiptIngestionProcessor(
    { resolveAndDownload },
    store,
    { extract },
    { upload },
    conversations,
    { readFile: () => Promise.resolve(bytes) },
  );
  return { processor, store, extract, upload, resolveAndDownload, cleanup };
};

describe('ReceiptIngestionProcessor (R2: download → extract → backend upload)', () => {
  it('downloads, extracts against the order total and uploads in one pass', async () => {
    const f = fixture();
    await expect(f.processor.process(row(), OWNER)).resolves.toMatchObject({
      kind: 'upload',
      report: { kind: 'uploaded' },
    });
    expect(f.resolveAndDownload).toHaveBeenCalledTimes(1);
    expect(f.store.commitDownload).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: '4' }),
    );
    expect(f.extract).toHaveBeenCalledWith({
      bytes: JPEG,
      mimeType: 'image/jpeg',
      expectedAmountCents: 150000,
    });
    // Upload attempt fenced on the post-download version (4 → 5 → 6).
    expect(f.store.startStorageAttempt).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '5',
      uploadFields: { extracted: { amountCents: 150000, confidence: 0.9 } },
    });
    expect(f.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        fence: { id: RECEIPT_ID, owner: OWNER, expectedVersion: '6' },
        file: { bytes: JPEG, mimeType: 'image/jpeg' },
        fields: { extracted: { amountCents: 150000, confidence: 0.9 } },
        order: { saleId: SALE_ID, folio: 'F-7', totalCents: 150000 },
      }),
    );
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('admits a PDF and uploads it', async () => {
    const f = fixture({ bytes: PDF, mime: 'application/pdf' });
    await f.processor.process(
      row({ declaredMimeType: 'application/pdf' }),
      OWNER,
    );
    expect(f.upload.mock.calls[0][0].file).toEqual({
      bytes: PDF,
      mimeType: 'application/pdf',
    });
  });

  it('refuses an encrypted PDF without extraction or upload', async () => {
    const f = fixture({ bytes: ENCRYPTED_PDF, mime: 'application/pdf' });
    await expect(
      f.processor.process(row({ declaredMimeType: 'application/pdf' }), OWNER),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'PDF_ENCRYPTED' });
    expect(f.store.commitRejectedMedia).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '5',
      reason: 'PDF_ENCRYPTED',
    });
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('never uploads an image that is not a receipt', async () => {
    const f = fixture({ extraction: { kind: 'not_receipt' } });
    await expect(f.processor.process(row(), OWNER)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'NOT_A_RECEIPT',
    });
    expect(f.store.startStorageAttempt).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('uploads when the extraction is unavailable', async () => {
    const unavailable: ReceiptExtraction = {
      kind: 'unavailable',
      reason: 'timeout',
    };
    const f = fixture({ extraction: unavailable });
    await f.processor.process(row(), OWNER);
    expect(f.upload.mock.calls[0][0].fields).toEqual({});
  });

  it('extracts without an expected amount when the placed order is another sale', async () => {
    const f = fixture({
      placedSale: {
        saleId: '44444444-4444-4444-8444-444444444444',
        folio: 'F-9',
        totalCents: 1,
      },
    });
    await f.processor.process(row(), OWNER);
    expect(f.extract.mock.calls[0][0].expectedAmountCents).toBeNull();
    expect(f.upload.mock.calls[0][0].order).toBeNull();
  });

  it('keeps the Meta failure disposition for the first download', async () => {
    const f = fixture({
      download: () =>
        Promise.reject(new MetaMediaError('META_TRANSPORT', 'TIMEOUT')),
    });
    await f.processor.process(row(), OWNER);
    expect(f.store.commitMetaFailureDisposition).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '4',
      category: 'META_TRANSPORT',
      code: 'TIMEOUT',
    });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('retries a DOWNLOADED row: fenced upload attempt, fresh download, same media', async () => {
    const f = fixture();
    await f.processor.process(
      row({ status: 'DOWNLOADED', version: '9', storageAttempts: 2 }),
      OWNER,
    );
    expect(f.store.startMetaAttempt).not.toHaveBeenCalled();
    expect(f.store.startStorageAttempt).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '9',
    });
    expect(f.resolveAndDownload).toHaveBeenCalledTimes(1);
    expect(f.upload.mock.calls[0][0].fence.expectedVersion).toBe('10');
  });

  it('persists the first-attempt upload fields with the attempt start', async () => {
    const f = fixture();
    await f.processor.process(row({ declaredAmountCents: 99900 }), OWNER);
    const fields = {
      declared: { amountCents: 99900 },
      extracted: { amountCents: 150000, confidence: 0.9 },
    };
    expect(f.store.startStorageAttempt).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '5',
      uploadFields: fields,
    });
    expect(f.upload.mock.calls[0][0].fields).toEqual(fields);
  });

  it('reuses the persisted upload fields on a retry without extracting again', async () => {
    const persisted = {
      declared: { amountCents: 99900 },
      extracted: { amountCents: 140000, bank: 'BBVA', confidence: 0.6 },
    };
    const f = fixture({ extraction: { kind: 'not_receipt' } });
    await f.processor.process(
      row({
        status: 'DOWNLOADED',
        version: '9',
        storageAttempts: 1,
        declaredAmountCents: 99900,
        uploadFields: persisted,
      }),
      OWNER,
    );
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.store.startStorageAttempt).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '9',
    });
    expect(f.upload.mock.calls[0][0].fields).toBe(persisted);
  });

  it('retries a row without persisted fields with the declared data only', async () => {
    const f = fixture();
    await f.processor.process(
      row({
        status: 'DOWNLOADED',
        version: '9',
        storageAttempts: 1,
        declaredAmountCents: 99900,
        uploadFields: null,
      }),
      OWNER,
    );
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.upload.mock.calls[0][0].fields).toEqual({
      declared: { amountCents: 99900 },
    });
  });

  it('treats a failed re-download as one more unknown upload attempt', async () => {
    const f = fixture({
      download: () =>
        Promise.reject(new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE')),
    });
    await f.processor.process(
      row({ status: 'DOWNLOADED', version: '9', storageAttempts: 1 }),
      OWNER,
    );
    expect(f.store.commitUploadUnknown).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '10',
      httpStatus: null,
      transportCode: 'META_NETWORK_FAILURE',
    });
    expect(f.store.commitMetaFailureDisposition).not.toHaveBeenCalled();
  });

  it('terminalizes a reclaimed last attempt as unknown without another upload', async () => {
    const f = fixture();
    await f.processor.process(
      row({
        status: 'DOWNLOADED',
        version: '9',
        storageAttempts: MAX_UPLOAD_ATTEMPTS,
      }),
      OWNER,
    );
    expect(f.store.commitUploadUnknown).toHaveBeenCalledWith({
      id: RECEIPT_ID,
      owner: OWNER,
      expectedVersion: '9',
      httpStatus: null,
      transportCode: 'TRANSPORT_FAILURE',
    });
    expect(f.resolveAndDownload).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('renews the lease while the extraction and upload run', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const f = fixture();
      f.upload.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ kind: 'unknown', outcome: committed });
          }),
      );
      const run = f.processor.process(row(), OWNER);
      await jest.advanceTimersByTimeAsync(45_000);
      expect(f.store.renewLease).toHaveBeenCalledWith({
        id: RECEIPT_ID,
        owner: OWNER,
        expectedVersion: '6',
      });
      release();
      await run;
      const calls = f.store.renewLease.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(f.store.renewLease.mock.calls.length).toBe(calls);
    } finally {
      jest.useRealTimers();
    }
  });

  it('declines any other claimed status', async () => {
    const f = fixture();
    await expect(
      f.processor.process(row({ status: 'ATTACHED' }), OWNER),
    ).resolves.toEqual({
      kind: 'unsupported-claimed-status',
      status: 'ATTACHED',
    });
    expect(f.resolveAndDownload).not.toHaveBeenCalled();
  });
});

/** S5: a Meta media failure is observable with a safe reason; the log text
 *  never carries the media id, any URL/query, or a token. */
describe('ReceiptIngestionProcessor Meta failure logging (S5)', () => {
  const MEDIA_ID = 'wa-media-1';
  const TOKEN = 'EAAG-token-sentinel';
  const URLISH = 'https://lookaside.fbsbx.com/x?mid=wa-media-1&hash=zzz';
  let warn: jest.SpyInstance<void, [message: unknown, ...rest: unknown[]]>;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  const netFailure = (reason: string) =>
    withMetaFailureReason(
      Object.assign(
        new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE'),
        {},
      ),
      reason,
    );

  const logged = (): string =>
    warn.mock.calls.map(([message]) => String(message)).join('\n');

  const expectClean = (text: string) => {
    expect(text).not.toContain(MEDIA_ID);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/https?:|\?|lookaside|mid=|hash=/i);
  };

  it('warns with reason, receipt id, category/code and attempt when a retry is scheduled', async () => {
    const f = fixture({
      download: () => Promise.reject(netFailure('ENETUNREACH')),
    });
    f.store.commitMetaFailureDisposition.mockResolvedValue({
      kind: 'retry-scheduled',
      attempt: 2,
      version: '5',
      receipt: row(),
    });
    await expect(f.processor.process(row(), OWNER)).resolves.toMatchObject({
      kind: 'meta-retry-scheduled',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const text = logged();
    expect(text).toContain(`receiptId=${RECEIPT_ID}`);
    expect(text).toContain('outcome=retry-scheduled');
    expect(text).toContain('category=META_TRANSPORT');
    expect(text).toContain('code=NETWORK_FAILURE');
    expect(text).toContain('attempt=2');
    expect(text).toContain('reason=ENETUNREACH');
    expectClean(text);
  });

  it('warns on a terminal Meta failure with the failure stage and attempt', async () => {
    const f = fixture({
      download: () => Promise.reject(netFailure('HOST_NOT_ALLOWED')),
    });
    f.store.commitMetaFailureDisposition.mockResolvedValue({
      kind: 'terminal',
      failureStage: 'META_EXHAUSTED_PRE_STORAGE',
      version: '6',
      receipt: row({ metaAttempts: 3 }),
      intent: {} as never,
    });
    await expect(
      f.processor.process(row({ metaAttempts: 2 }), OWNER),
    ).resolves.toMatchObject({ kind: 'meta-terminal' });
    const text = logged();
    expect(text).toContain(`receiptId=${RECEIPT_ID}`);
    expect(text).toContain('outcome=terminal');
    expect(text).toContain('failureStage=META_EXHAUSTED_PRE_STORAGE');
    expect(text).toContain('code=NETWORK_FAILURE');
    expect(text).toContain('attempt=3');
    expect(text).toContain('reason=HOST_NOT_ALLOWED');
    expectClean(text);
  });

  it('includes the HTTP status (from its side-channel) and never an unsafe error message', async () => {
    const client = new MetaMediaClient(
      {
        graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
        allowedHosts: ['lookaside.fbsbx.com'],
        metadataTimeoutMs: 1000,
        downloadTimeoutMs: 1000,
      },
      () => TOKEN,
      {
        http: () => Promise.resolve({ status: 503, data: URLISH }),
        resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
        createAgent: () => ({ destroy: jest.fn() }) as never,
      },
    );
    const f = fixture({
      download: () =>
        client.resolveAndDownload({
          providerMediaId: MEDIA_ID,
          declaredMimeType: 'image/jpeg',
          signal: new AbortController().signal,
        }),
    });
    f.store.commitMetaFailureDisposition.mockResolvedValue({
      kind: 'retry-scheduled',
      attempt: 1,
      version: '5',
      receipt: row(),
    });
    await f.processor.process(row(), OWNER);
    const text = logged();
    expect(text).toContain('code=HTTP_RETRYABLE');
    expect(text).toContain('httpStatus=503');
    expectClean(text);
  });

  it('warns for a download failure on the same-key retry pass too', async () => {
    const f = fixture({
      download: () => Promise.reject(netFailure('ECONNRESET')),
    });
    await f.processor.process(
      row({ status: 'DOWNLOADED', version: '9', storageAttempts: 1 }),
      OWNER,
    );
    const text = logged();
    expect(text).toContain(`receiptId=${RECEIPT_ID}`);
    expect(text).toContain('outcome=upload-retry-download-failed');
    expect(text).toContain('reason=ECONNRESET');
    expectClean(text);
  });

  it('does not warn on abort, a fenced loser, or a successful pass', async () => {
    const aborted = fixture({
      download: () =>
        Promise.reject(new MetaMediaError('META_TRANSPORT', 'ABORTED')),
    });
    await aborted.processor.process(row(), OWNER);
    const fenced = fixture({
      download: () => Promise.reject(netFailure('ENETUNREACH')),
    });
    await fenced.processor.process(row(), OWNER); // default store → fenced
    await fixture().processor.process(row(), OWNER);
    expect(warn).not.toHaveBeenCalled();
  });
});
