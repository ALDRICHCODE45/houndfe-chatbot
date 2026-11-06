import {
  RECEIPT_MEDIA_STATUSES,
  type ReceiptMediaRow,
} from '../domain/receipt-media.types';
import type { ReceiptIngestionOutcome } from './receipt-ingestion.processor';
import { ReceiptProcessingDispatcher } from './receipt-processing-dispatcher.service';

const row = (status: ReceiptMediaRow['status']): ReceiptMediaRow =>
  ({ id: 'r-1', status, version: '1' }) as ReceiptMediaRow;

const fixture = () => {
  const outcome: ReceiptIngestionOutcome = { kind: 'cleanup-failed' };
  const process = jest.fn().mockResolvedValue(outcome);
  return {
    process,
    outcome,
    dispatcher: new ReceiptProcessingDispatcher({ process }),
  };
};

describe('ReceiptProcessingDispatcher (R2)', () => {
  it.each(['RESERVED', 'DOWNLOADED'] as const)(
    'dispatches %s exactly once with owner and signal',
    async (status) => {
      const { process, outcome, dispatcher } = fixture();
      const signal = new AbortController().signal;
      const receipt = row(status);
      await expect(dispatcher.dispatch(receipt, 'w', signal)).resolves.toEqual({
        kind: 'dispatched',
        outcome,
      });
      expect(process).toHaveBeenCalledTimes(1);
      expect(process).toHaveBeenCalledWith(receipt, 'w', signal);
    },
  );

  it.each(
    RECEIPT_MEDIA_STATUSES.filter(
      (s) => s !== 'RESERVED' && s !== 'DOWNLOADED',
    ),
  )('declines %s with no collaborator call', async (status) => {
    const { process, dispatcher } = fixture();
    await expect(dispatcher.dispatch(row(status), 'w')).resolves.toEqual({
      kind: 'non-dispatched',
      status,
    });
    expect(process).not.toHaveBeenCalled();
  });

  it('propagates processor errors unchanged', async () => {
    const { process, dispatcher } = fixture();
    const error = new Error('boom');
    process.mockRejectedValue(error);
    await expect(dispatcher.dispatch(row('RESERVED'), 'w')).rejects.toBe(error);
  });
});
