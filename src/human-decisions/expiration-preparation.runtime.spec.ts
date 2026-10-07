import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { ChatbotApiClient } from '../chatbot-api/domain/chatbot-api.client';
import { ExpirationPreparationRuntime } from './expiration-preparation.runtime';
import { ExpirationRecoveryPoller } from './application/expiration-recovery-poller';

describe('ExpirationPreparationRuntime', () => {
  afterEach(() => jest.restoreAllMocks());
  function build(enabled: unknown, branch: unknown = 'branch') {
    const config = {
      get: (key: string) =>
        key === 'minimalCatalogAgent.expirationEnabled' ? enabled : branch,
    } as ConfigService;
    return new ExpirationPreparationRuntime(
      config,
      {} as Pool,
      {} as ChatbotApiClient,
    );
  }
  it.each([false, undefined, 'true'])(
    'does not start with gate %s',
    async (enabled) => {
      const start = jest
        .spyOn(ExpirationRecoveryPoller.prototype, 'start')
        .mockImplementation();
      const runtime = build(enabled);
      runtime.onApplicationBootstrap();
      expect(start).not.toHaveBeenCalled();
      await runtime.onModuleDestroy();
    },
  );
  it('starts once with a valid branch and drains the poller on shutdown', async () => {
    const start = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'start')
      .mockImplementation();
    const stop = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'stop')
      .mockResolvedValue();
    const runtime = build(true);
    runtime.onApplicationBootstrap();
    runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    await runtime.onModuleDestroy();
    runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('rejects missing branch identity before starting', () => {
    const start = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'start')
      .mockImplementation();
    expect(() => build(true, '').onApplicationBootstrap()).toThrow(
      'EXPIRATION preparation requires branch identity',
    );
    expect(start).not.toHaveBeenCalled();
  });
});
