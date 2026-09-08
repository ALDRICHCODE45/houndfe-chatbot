/** WU6D2 HEAD-only capability metadata controller (design "Reviewer access"):
 *  thin transport mapping over the WU6D1 ReceiptCapabilityAuthorizerService
 *  closed result — denied → empty 404, unavailable/fail-closed → empty 503
 *  with fixed Retry-After, authorized+Range → 416 without storage, else one
 *  private HeadObject call. Authorization precedes Range; no token/object/
 *  provider detail; no retries; GET later; not production-wired yet. */
import { Controller, Head, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ReceiptCapabilityAuthorizerService,
  type ReceiptCapabilityAuthorization,
} from '../application/receipt-capability-authorizer.service';
import {
  OBJECT_STORAGE_PORT,
  ObjectStorageError,
  type HeadObjectResult,
  type ObjectStoragePort,
} from '../domain/object-storage.port';

/** Fixed Retry-After (seconds) for the single empty 503. */
export const CAPABILITY_RETRY_AFTER_SECONDS = 5;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

@Controller('media')
export class ReceiptMediaAccessController {
  constructor(
    private readonly authorizer: ReceiptCapabilityAuthorizerService,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  @Head('receipts/:token')
  async head(
    @Req() req: Request,
    @Res() res: Response,
    @Param('token') rawToken: string,
  ): Promise<void> {
    const abort = new AbortController();
    const onDisconnected = (): void => abort.abort();
    res.once('close', onDisconnected);
    try {
      let authorization: ReceiptCapabilityAuthorization;
      try {
        authorization = await this.authorizer.authorize(rawToken);
      } catch {
        // Fail-closed 503, but a disconnected client gets no response.
        if (abort.signal.aborted) return;
        return this.unavailable(res);
      }
      // Client gone during authorization: no storage, no response.
      if (abort.signal.aborted) return;
      if (authorization.kind === 'unavailable') return this.unavailable(res);
      if (authorization.kind === 'denied') return this.empty(res, 404);
      if (req.headers.range !== undefined) {
        // Range is unsupported in v1; authorized callers get 416, no storage.
        return this.empty(res, 416);
      }
      let meta: HeadObjectResult;
      try {
        meta = await this.storage.head({
          key: authorization.objectKey,
          abortSignal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        return error instanceof ObjectStorageError &&
          error.code === 'OBJECT_NOT_FOUND'
          ? this.empty(res, 404)
          : this.unavailable(res);
      }
      if (abort.signal.aborted) return;
      this.sendMetadata(res, meta);
    } finally {
      res.off('close', onDisconnected);
    }
  }

  private unavailable(res: Response): void {
    res.setHeader('Retry-After', String(CAPABILITY_RETRY_AFTER_SECONDS));
    this.empty(res, 503);
  }

  private empty(res: Response, status: number): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    res.setHeader('Content-Length', '0');
    res.status(status);
    res.end();
  }

  private sendMetadata(res: Response, meta: HeadObjectResult): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Length', String(meta.byteCount));
    // MIME is validated to exactly image/jpeg|image/png by the storage port.
    const filename =
      meta.mimeType === 'image/png' ? 'receipt.png' : 'receipt.jpg';
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.status(200);
    res.end();
  }
}
