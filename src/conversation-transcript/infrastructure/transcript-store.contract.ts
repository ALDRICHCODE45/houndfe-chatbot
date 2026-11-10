import type {
  ConversationTranscriptStore,
  TranscriptMessageInput,
} from '../domain/transcript.port';

/**
 * Shared contract for every `ConversationTranscriptStore` adapter:
 * idempotent append on the WhatsApp message id, newest-N history read in
 * chronological order per sender, ISO-8601 UTC round trip, and a bounded
 * purge of due rows only.
 */
export type TranscriptStoreFactory = () => Promise<{
  store: ConversationTranscriptStore;
  cleanup?: () => Promise<void>;
}>;

const SENDER = '5215550001111';
const OTHER = '5215550002222';
const T0 = new Date('2026-11-09T16:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const inbound = (
  waMessageId: string,
  seconds: number,
  patch: Partial<TranscriptMessageInput> = {},
): TranscriptMessageInput => ({
  senderId: SENDER,
  waMessageId,
  direction: 'IN',
  author: 'CUSTOMER',
  type: 'text',
  text: `msg ${waMessageId}`,
  providerTimestamp: at(seconds - 1).toISOString(),
  observedAt: at(seconds),
  ...patch,
});

export function runTranscriptStoreContract(
  label: string,
  makeStore: TranscriptStoreFactory,
): void {
  describe(`ConversationTranscriptStore contract — ${label}`, () => {
    let store: ConversationTranscriptStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      ({ store, cleanup } = await makeStore());
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it('lists nothing for an unknown sender', async () => {
      await expect(store.listRecent(SENDER, 10)).resolves.toEqual([]);
    });

    it('appends once per WhatsApp message id and reads it back', async () => {
      await expect(store.append(inbound('wamid.1', 0))).resolves.toBe(true);
      await expect(
        store.append(inbound('wamid.1', 5, { text: 'replayed' })),
      ).resolves.toBe(false);
      await expect(store.listRecent(SENDER, 10)).resolves.toEqual([
        {
          senderId: SENDER,
          waMessageId: 'wamid.1',
          direction: 'IN',
          author: 'CUSTOMER',
          type: 'text',
          text: 'msg wamid.1',
          media: null,
          details: null,
          providerTimestamp: '2026-11-09T15:59:59.000Z',
          observedAt: '2026-11-09T16:00:00.000Z',
          purgeAfter: '2027-11-09T16:00:00.000Z',
        },
      ]);
    });

    it('keeps media, details and bot outbound rows', async () => {
      await store.append(
        inbound('wamid.img', 0, {
          type: 'image',
          text: 'caption',
          media: {
            providerMediaId: 'media-1',
            mimeType: 'image/jpeg',
            filename: 'a.jpg',
          },
        }),
      );
      await store.append({
        senderId: SENDER,
        waMessageId: 'wamid.out',
        direction: 'OUT',
        author: 'BOT',
        type: 'template',
        details: { templateName: 'order_ready', bodyParameters: ['F-1'] },
        observedAt: at(1),
      });
      const rows = await store.listRecent(SENDER, 10);
      expect(rows.map((row) => row.waMessageId)).toEqual([
        'wamid.img',
        'wamid.out',
      ]);
      expect(rows[0].media).toEqual({
        providerMediaId: 'media-1',
        mimeType: 'image/jpeg',
        filename: 'a.jpg',
      });
      expect(rows[1]).toMatchObject({
        direction: 'OUT',
        author: 'BOT',
        type: 'template',
        text: null,
        providerTimestamp: null,
        details: { templateName: 'order_ready', bodyParameters: ['F-1'] },
      });
    });

    it('returns the newest N of one sender, oldest first', async () => {
      for (let i = 0; i < 5; i += 1)
        await store.append(inbound(`wamid.${i}`, i));
      await store.append(inbound('wamid.other', 10, { senderId: OTHER }));
      const rows = await store.listRecent(SENDER, 3);
      expect(rows.map((row) => row.waMessageId)).toEqual([
        'wamid.2',
        'wamid.3',
        'wamid.4',
      ]);
      await expect(store.listRecent('not-a-sender', 3)).resolves.toEqual([]);
    });

    it('refuses an invalid message without writing', async () => {
      await expect(
        store.append(inbound('wamid.bad', 0, { senderId: 'abc' })),
      ).rejects.toThrow('Invalid transcript message: senderId');
      await expect(store.listRecent(SENDER, 10)).resolves.toEqual([]);
    });

    it('purges only due rows, at most one batch per call', async () => {
      const longAgo = new Date('2025-01-01T00:00:00.000Z');
      for (let i = 0; i < 3; i += 1)
        await store.append(
          inbound(`wamid.old.${i}`, 0, {
            observedAt: new Date(longAgo.getTime() + i),
          }),
        );
      await store.append(inbound('wamid.fresh', 0));
      const now = new Date('2026-11-09T17:00:00.000Z');
      await expect(store.purgeExpired(now, 2)).resolves.toBe(2);
      await expect(store.purgeExpired(now, 2)).resolves.toBe(1);
      await expect(store.purgeExpired(now, 2)).resolves.toBe(0);
      const rows = await store.listRecent(SENDER, 10);
      expect(rows.map((row) => row.waMessageId)).toEqual(['wamid.fresh']);
    });

    it('purges a row exactly at its purge time', async () => {
      await store.append(inbound('wamid.edge', 0));
      await expect(
        store.purgeExpired(new Date('2027-11-09T15:59:59.999Z'), 10),
      ).resolves.toBe(0);
      await expect(
        store.purgeExpired(new Date('2027-11-09T16:00:00.000Z'), 10),
      ).resolves.toBe(1);
    });
  });
}
