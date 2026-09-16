import { RECEIPT_MEDIA_STATUSES } from '../domain/receipt-media.types';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { ReceiptAttachmentService } from './receipt-attachment.service';
import { ReceiptProcessingDispatcher } from './receipt-processing-dispatcher.service';
import type { DispatchedOutcome } from './receipt-processing-dispatcher.service';
import type { ReceiptIngestionProcessor } from './receipt-ingestion.processor';

const OWNER = 'dispatch-test-owner';
const RECEIPT_ID = 'aaaa1111-1111-4111-8111-111111111111';
const SALE_ID = 'bbbb2222-2222-4222-8222-222222222222';

const DISPATCH_STATES = RECEIPT_MEDIA_STATUSES;

function makeReceipt(
  status: string,
  overrides: Partial<ReceiptMediaRow> = {},
): ReceiptMediaRow {
  return {
    id: RECEIPT_ID,
    webhookMessageId: 'wmid',
    providerMediaId: 'pmid',
    senderId: 'sid',
    capturedSaleId: SALE_ID,
    objectKey: `receipts/${RECEIPT_ID}`,
    status,
    version: '1',
    declaredMimeType: 'image/jpeg',
    createdAt: new Date(),
    updatedAt: new Date(),
    reservedAt: new Date(),
    downloadedAt: null,
    storedAt: null,
    amountProposedAt: null,
    attachStartedAt: null,
    attachRequestStartedAt: null,
    attachedAt: null,
    terminalAt: null,
    responseMimeType: null,
    detectedMimeType: null,
    providerDeclaredBytes: null,
    byteCount: null,
    contentSha256: null,
    objectEtag: null,
    objectVersionId: null,
    capabilityTokenHash: null,
    capabilityKeyVersion: null,
    capabilityIssuedAt: null,
    capabilityRevokedAt: null,
    declaredAmountCents: status === 'ATTACHING' ? 15000 : null,
    backendReceiptId: null,
    backendReceiptStatus: null,
    attachAttemptId: null,
    attachAttempts: 0,
    metaAttempts: 0,
    storageAttempts: 0,
    nextAttemptAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    failureStage: null,
    lastErrorCategory: null,
    lastErrorCode: null,
    attachHttpStatus: null,
    attachTransportCode: null,
    attachOutcomeObservedAt: null,
    cleanupPending: false,
    cleanupAttempts: 0,
    reconciliationDisposition: null,
    reconciledBackendReceiptId: null,
    reconciledAt: null,
    reconciledBy: null,
    ...overrides,
  } as ReceiptMediaRow;
}

describe('ReceiptProcessingDispatcher', () => {
  // Collaborator interfaces — only the methods actually called by the dispatcher
  let ingestion: jest.Mocked<Pick<ReceiptIngestionProcessor, 'process'>>;
  let attachment: jest.Mocked<Pick<ReceiptAttachmentService, 'attach'>>;
  let dispatcher: ReceiptProcessingDispatcher;

  beforeEach(() => {
    ingestion = { process: jest.fn() };
    attachment = { attach: jest.fn() };
    dispatcher = new ReceiptProcessingDispatcher(ingestion, attachment);
  });

  // -------------------------------------------------------------------------
  // Dispatch routing — RESERVED / DOWNLOADED → ingestion, ATTACHING → attachment
  // -------------------------------------------------------------------------

  it.each(['RESERVED', 'DOWNLOADED'] as const)(
    'status %s delegates to ingestion.process exactly once with receipt, owner, and signal',
    async (status) => {
      const receipt = makeReceipt(status);
      const controller = new AbortController();
      const ingestionOutcome = { kind: 'downloaded' as const };
      ingestion.process.mockResolvedValue(ingestionOutcome);

      const result = await dispatcher.dispatch(
        receipt,
        OWNER,
        controller.signal,
      );

      expect(result).toEqual({
        kind: 'dispatched',
        outcome: ingestionOutcome,
      });
      expect((result as DispatchedOutcome).outcome).toBe(ingestionOutcome);
      expect(ingestion.process).toHaveBeenCalledTimes(1);
      expect(ingestion.process).toHaveBeenCalledWith(
        receipt,
        OWNER,
        controller.signal,
      );
      expect(attachment.attach).not.toHaveBeenCalled();
    },
  );

  it('status ATTACHING delegates to attachment.attach exactly once with receipt, owner, and signal', async () => {
    const receipt = makeReceipt('ATTACHING');
    const controller = new AbortController();
    const attachmentOutcome = {
      kind: 'attached' as const,
      backendReceiptId: 'br1',
    };
    attachment.attach.mockResolvedValue(attachmentOutcome);

    const result = await dispatcher.dispatch(receipt, OWNER, controller.signal);

    expect(result).toEqual({
      kind: 'dispatched',
      outcome: attachmentOutcome,
    });
    expect((result as DispatchedOutcome).outcome).toBe(attachmentOutcome);
    expect(attachment.attach).toHaveBeenCalledTimes(1);
    expect(attachment.attach).toHaveBeenCalledWith({
      receipt,
      owner: OWNER,
      signal: controller.signal,
    });
    expect(ingestion.process).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Non-dispatch statuses — zero collaborator calls
  // -------------------------------------------------------------------------

  describe.each([
    // amount states
    'AWAITING_AMOUNT',
    'AWAITING_CONFIRMATION',
    // STORED
    'STORED',
    // terminal states
    'ATTACHED',
    'FAILED',
    'CANCELLED',
    'ATTACH_OUTCOME_UNKNOWN',
  ])('non-dispatch status %s', (status) => {
    it('returns non-dispatched result and calls neither collaborator', async () => {
      const receipt = makeReceipt(status);
      const result = await dispatcher.dispatch(receipt, OWNER);
      expect(result).toEqual({ kind: 'non-dispatched', status });
      expect(ingestion.process).not.toHaveBeenCalled();
      expect(attachment.attach).not.toHaveBeenCalled();
    });

    it('accepts an AbortSignal without affecting non-dispatch', async () => {
      const receipt = makeReceipt(status);
      const controller = new AbortController();
      const result = await dispatcher.dispatch(
        receipt,
        OWNER,
        controller.signal,
      );
      expect(result).toEqual({ kind: 'non-dispatched', status });
      expect(ingestion.process).not.toHaveBeenCalled();
      expect(attachment.attach).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation — collaborator errors bubble unchanged
  // -------------------------------------------------------------------------

  it('propagates ingestion errors unchanged without calling attachment', async () => {
    const receipt = makeReceipt('DOWNLOADED');
    const err = new Error('ingestion-db-down');
    ingestion.process.mockRejectedValue(err);

    await expect(dispatcher.dispatch(receipt, OWNER)).rejects.toBe(err);
    expect(ingestion.process).toHaveBeenCalledTimes(1);
    expect(attachment.attach).not.toHaveBeenCalled();
  });

  it('propagates attachment errors unchanged without calling ingestion', async () => {
    const receipt = makeReceipt('ATTACHING');
    const err = new Error('attachment-db-down');
    attachment.attach.mockRejectedValue(err);

    await expect(dispatcher.dispatch(receipt, OWNER)).rejects.toBe(err);
    expect(attachment.attach).toHaveBeenCalledTimes(1);
    expect(ingestion.process).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Signal forwarding — already-aborted signal is forwarded as-is
  // -------------------------------------------------------------------------

  it('forwards an already-aborted signal to ingestion without pre-empting', async () => {
    const receipt = makeReceipt('RESERVED');
    const controller = new AbortController();
    controller.abort();
    ingestion.process.mockResolvedValue({ kind: 'aborted', stage: 'meta' });

    const result = await dispatcher.dispatch(receipt, OWNER, controller.signal);

    expect(result).toEqual({
      kind: 'dispatched',
      outcome: { kind: 'aborted', stage: 'meta' },
    });
    expect(ingestion.process).toHaveBeenCalledWith(
      receipt,
      OWNER,
      controller.signal,
    );
  });

  it('forwards an already-aborted signal to attachment without pre-empting', async () => {
    const receipt = makeReceipt('ATTACHING');
    const controller = new AbortController();
    controller.abort();
    attachment.attach.mockResolvedValue({
      kind: 'skipped',
      reason: 'fenced',
    });

    const result = await dispatcher.dispatch(receipt, OWNER, controller.signal);

    expect(result).toEqual({
      kind: 'dispatched',
      outcome: { kind: 'skipped', reason: 'fenced' },
    });
    expect(attachment.attach).toHaveBeenCalledWith({
      receipt,
      owner: OWNER,
      signal: controller.signal,
    });
  });

  // -------------------------------------------------------------------------
  // Constructor inertness — no calls during construction
  // -------------------------------------------------------------------------

  it('makes no collaborator calls during construction', () => {
    const silentIngestion = { process: jest.fn() };
    const silentAttachment = { attach: jest.fn() };
    new ReceiptProcessingDispatcher(silentIngestion, silentAttachment);
    expect(silentIngestion.process).not.toHaveBeenCalled();
    expect(silentAttachment.attach).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Complete status matrix coverage
  // -------------------------------------------------------------------------

  it.each(DISPATCH_STATES)(
    'covers every declared status: %s',
    async (status) => {
      const receipt = makeReceipt(status);
      if (status === 'RESERVED' || status === 'DOWNLOADED') {
        ingestion.process.mockResolvedValue({ kind: 'downloaded' });
      } else if (status === 'ATTACHING') {
        attachment.attach.mockResolvedValue({
          kind: 'skipped',
          reason: 'fenced',
        });
      }
      // The dispatcher must not throw — every status maps to a valid union member.
      const result = await dispatcher.dispatch(receipt, OWNER);
      const isDispatched = result.kind === 'dispatched';
      const isNonDispatched = result.kind === 'non-dispatched';
      expect(isDispatched || isNonDispatched).toBe(true);
    },
  );

  it('returns non-dispatched for an unsupported runtime status with zero collaborator calls', async () => {
    const unknownStatus = 'RUNTIME_UNSUPPORTED' as ReceiptMediaRow['status'];
    const receipt = makeReceipt(unknownStatus);
    const result = await dispatcher.dispatch(receipt, OWNER);
    expect(result).toEqual({
      kind: 'non-dispatched',
      status: unknownStatus,
    });
    expect(ingestion.process).not.toHaveBeenCalled();
    expect(attachment.attach).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Argument identity — receipt and owner passed unchanged
  // -------------------------------------------------------------------------

  it('passes receipt identity unchanged to ingestion for RESERVED', async () => {
    const receipt = makeReceipt('RESERVED');
    ingestion.process.mockResolvedValue({ kind: 'downloaded' });

    await dispatcher.dispatch(receipt, OWNER);

    expect(ingestion.process.mock.calls[0][0]).toBe(receipt);
  });

  it('passes receipt identity unchanged to attachment for ATTACHING', async () => {
    const receipt = makeReceipt('ATTACHING');
    attachment.attach.mockResolvedValue({
      kind: 'attached',
      backendReceiptId: 'x',
    });

    await dispatcher.dispatch(receipt, OWNER);

    expect(attachment.attach.mock.calls[0][0].receipt).toBe(receipt);
  });

  it('passes owner identity unchanged for both routes', async () => {
    const r1 = makeReceipt('DOWNLOADED');
    const r2 = makeReceipt('ATTACHING');
    ingestion.process.mockResolvedValue({ kind: 'downloaded' });
    attachment.attach.mockResolvedValue({
      kind: 'attached',
      backendReceiptId: 'x',
    });

    await dispatcher.dispatch(r1, 'owner-abc');
    await dispatcher.dispatch(r2, 'owner-abc');

    expect(ingestion.process.mock.calls[0][1]).toBe('owner-abc');
    expect(attachment.attach.mock.calls[0][0].owner).toBe('owner-abc');
  });

  it('omits signal when undefined for ingestion route', async () => {
    const receipt = makeReceipt('RESERVED');
    ingestion.process.mockResolvedValue({ kind: 'downloaded' });

    await dispatcher.dispatch(receipt, OWNER);

    expect(ingestion.process.mock.calls[0][2]).toBeUndefined();
  });

  it('omits signal when undefined for attachment route', async () => {
    const receipt = makeReceipt('ATTACHING');
    attachment.attach.mockResolvedValue({
      kind: 'skipped',
      reason: 'fenced',
    });

    await dispatcher.dispatch(receipt, OWNER);

    expect(attachment.attach.mock.calls[0][0].signal).toBeUndefined();
  });
});
