import { normalizeMetaStatuses } from './meta-status-normalizer';

const RECIPIENT = '5215550001111';

const event = (...statuses: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { statuses } }] }],
});

const status = (patch: Record<string, unknown> = {}) => ({
  id: 'wamid.out-1',
  status: 'delivered',
  timestamp: '1762704132',
  recipient_id: RECIPIENT,
  ...patch,
});

describe('normalizeMetaStatuses (S3)', () => {
  it('maps every known status with an ISO-8601 UTC ms time', () => {
    const result = normalizeMetaStatuses(
      event(
        status({ status: 'sent' }),
        status({ status: 'delivered' }),
        status({ status: 'read' }),
      ),
    );
    expect(result.ignored).toEqual([]);
    expect(result.statuses).toEqual(
      ['sent', 'delivered', 'read'].map((value) => ({
        providerMessageId: 'wamid.out-1',
        recipientWaId: RECIPIENT,
        status: value,
        occurredAt: '2025-11-09T16:02:12.000Z',
      })),
    );
  });

  it('a failed status carries the first error code as a string and its title', () => {
    const result = normalizeMetaStatuses(
      event(
        status({
          status: 'failed',
          errors: [
            { code: 131047, title: 'Re-engagement message' },
            { code: 1, title: 'other' },
          ],
        }),
      ),
    );
    expect(result.statuses).toEqual([
      {
        providerMessageId: 'wamid.out-1',
        recipientWaId: RECIPIENT,
        status: 'failed',
        occurredAt: '2025-11-09T16:02:12.000Z',
        errorCode: '131047',
        errorTitle: 'Re-engagement message',
      },
    ]);
  });

  it('ignores unknown status values and malformed items, reporting why', () => {
    const result = normalizeMetaStatuses(
      event(
        status({ status: 'deleted' }),
        status({ id: undefined }),
        status({ recipient_id: 'abc' }),
        status({ timestamp: 'later' }),
        'not an object',
      ),
    );
    expect(result.statuses).toEqual([]);
    expect(result.ignored.map((item) => item.reason)).toEqual([
      'status',
      'id',
      'recipient',
      'timestamp',
      'shape',
    ]);
    expect(result.ignored[0]).toMatchObject({
      providerMessageId: 'wamid.out-1',
      status: 'deleted',
    });
  });

  it('reads statuses across entries and changes, and nothing from messages', () => {
    const result = normalizeMetaStatuses({
      entry: [
        { changes: [{ value: { messages: [{ id: 'wamid.in' }] } }] },
        { changes: [{ value: { statuses: [status({ id: 'wamid.a' })] } }] },
        {
          changes: [
            { value: { statuses: [status({ id: 'wamid.b' })] } },
            { value: null },
          ],
        },
      ],
    });
    expect(result.statuses.map((item) => item.providerMessageId)).toEqual([
      'wamid.a',
      'wamid.b',
    ]);
  });

  it('returns nothing for a payload without entries', () => {
    expect(normalizeMetaStatuses({})).toEqual({ statuses: [], ignored: [] });
    expect(normalizeMetaStatuses(null)).toEqual({ statuses: [], ignored: [] });
  });
});
