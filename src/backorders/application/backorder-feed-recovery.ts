import { Logger } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '../../chatbot-api/domain/errors';
import type { BackorderRecoveryClient } from '../domain/backorder';

/**
 * The backorder step of the feed recovery after `410 CURSOR_EXPIRED`
 * (`HumanRequestFeedConsumerPorts.backorders`): the position re-serving the
 * oldest unacknowledged `backorder.*` item.
 *
 * A transient failure (5xx, 429, network, invalid body) propagates, so the
 * walk saves nothing and runs again. A 403 or 404 (the credential lacks
 * `backorders:read`, or the backend has no backorders yet) means "no
 * position": a missing grant must not block the recovery of every other feed
 * item. It is logged once per process.
 */
export class BackorderFeedRecovery {
  private readonly logger = new Logger(BackorderFeedRecovery.name);
  private warned = false;

  constructor(private readonly client: BackorderRecoveryClient) {}

  async undeliveredResumeAfter(
    updatedSince: string | null,
  ): Promise<string | null> {
    try {
      return await this.client.undeliveredResumeAfter(updatedSince);
    } catch (error) {
      if (!(error instanceof ForbiddenError || error instanceof NotFoundError))
        throw error;
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `backorder recovery position unavailable (HTTP ${error.statusCode}): feed recovery continues without it; grant backorders:read to the chatbot credential`,
        );
      }
      return null;
    }
  }
}
