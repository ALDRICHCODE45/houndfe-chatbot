import { Logger } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { BackorderFeedRecovery } from './backorder-feed-recovery';

describe('BackorderFeedRecovery (restock backorder T5a, recovery after 410)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns the backend position and passes updatedSince through', async () => {
    const client = {
      undeliveredResumeAfter: jest.fn(() => Promise.resolve('000000004310')),
    };
    await expect(
      new BackorderFeedRecovery(client).undeliveredResumeAfter(
        '2026-11-20T10:00:00.000Z',
      ),
    ).resolves.toBe('000000004310');
    expect(client.undeliveredResumeAfter).toHaveBeenCalledWith(
      '2026-11-20T10:00:00.000Z',
    );
  });

  it.each([
    ['403 (no backorders:read scope)', new ForbiddenError('no', 403)],
    ['404 (route not deployed)', new NotFoundError('no', 404)],
  ])(
    '%s degrades to "no position" with a warning, so the whole feed recovery is not blocked',
    async (_name, error) => {
      const recovery = new BackorderFeedRecovery({
        undeliveredResumeAfter: () => Promise.reject(error),
      });
      await expect(recovery.undeliveredResumeAfter(null)).resolves.toBeNull();
      await expect(recovery.undeliveredResumeAfter(null)).resolves.toBeNull();
      // Warned once, not on every recovery pass.
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['a 5xx', new UpstreamError('down', 503)],
    ['a rate limit', new RateLimitError(5)],
    ['a network failure', new Error('ECONNRESET')],
    ['an invalid body', new UpstreamError('invalid', 200)],
  ])(
    '%s is transient: it propagates so the walk saves nothing',
    async (_name, error) => {
      const recovery = new BackorderFeedRecovery({
        undeliveredResumeAfter: () => Promise.reject(error),
      });
      await expect(recovery.undeliveredResumeAfter(null)).rejects.toBe(error);
    },
  );
});
