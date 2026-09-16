/** WU15-2 metrics exposition controller.
 *
 * Route: GET /internal/receipt-media/metrics
 * Auth:  ReceiptMetricsAuthGuard (dedicated Bearer token, REAL guard).
 *
 * Behavior:
 *   - Metrics disabled → 404 (no auth inspection)
 *   - Metrics enabled + invalid/missing token → 401
 *   - Metrics enabled + valid token → 200, Prometheus text, no-store
 *   - Serialization failure → 503 with fixed safe body (no raw details)
 *   - Token only through Authorization header; query/cookies denied
 *
 * Notes:
 *   - The /internal path prefix is NOT a private-network boundary.
 *   - No Prometheus scrape runs storage/provider calls during serialization.
 *   - The controller does not own the Prometheus target lifecycle.
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReceiptMetricsAuthGuard } from './receipt-metrics-auth.guard';
import {
  PrometheusReceiptTelemetry,
  RECEIPT_TELEMETRY,
} from '../infrastructure/prometheus-receipt-telemetry';

/** Safe fixed text returned on serialization failure. */
const SERIALIZATION_ERROR_TEXT = 'metrics unavailable';

/** Safe fixed status code for serialization failure. */
const SERIALIZATION_ERROR_STATUS = HttpStatus.SERVICE_UNAVAILABLE;

@Controller('internal/receipt-media')
export class ReceiptMetricsController {
  constructor(
    @Inject(RECEIPT_TELEMETRY)
    private readonly telemetry: PrometheusReceiptTelemetry,
  ) {}

  @Get('metrics')
  @UseGuards(ReceiptMetricsAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getMetrics(@Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const contentType = this.telemetry.contentType();
      const metrics = await this.telemetry.metrics();
      res.setHeader('Content-Type', contentType);
      res.status(HttpStatus.OK).send(metrics);
    } catch {
      // Failed scrapes are not successful Prometheus payloads.
      res
        .status(SERIALIZATION_ERROR_STATUS)
        .type('text/plain')
        .send(SERIALIZATION_ERROR_TEXT);
    }
  }
}
