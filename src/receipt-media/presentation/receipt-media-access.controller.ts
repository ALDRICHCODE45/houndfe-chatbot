/** WU6D2 HEAD + WU6E1 GET capability media controller (design "Reviewer
 *  access"): thin transport mapping over the WU6D1 ReceiptCapabilityAuthorizerService
 *  closed result — denied → empty 404, unavailable/fail-closed → empty 503
 *  with fixed Retry-After, authorized+Range → 416 without storage, else one
 *  private HeadObject (HEAD) or one private getStream piped to the response
 *  (GET). Authorization precedes Range; no token/object/provider detail; no
 *  retries; GET disconnect aborts/destroys the stream and post-header stream
 *  failure terminates the connection; not production-wired yet. */
import { Controller, Get, Head, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ReceiptCapabilityAuthorizerService,
  type ReceiptCapabilityAuthorization,
} from '../application/receipt-capability-authorizer.service';
import {
  OBJECT_STORAGE_PORT,
  ObjectStorageError,
  type GetObjectResult,
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
      const authorization = await this.authorizeOrRespond(res, abort, rawToken);
      if (authorization === null) return;
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

  @Get('receipts/:token')
  async get(
    @Req() req: Request,
    @Res() res: Response,
    @Param('token') rawToken: string,
  ): Promise<void> {
    const abort = new AbortController();
    const onDisconnected = (): void => abort.abort();
    res.once('close', onDisconnected);
    let streaming = false;
    try {
      const authorization = await this.authorizeOrRespond(res, abort, rawToken);
      if (authorization === null) return;
      if (authorization.kind === 'denied') return this.empty(res, 404);
      if (req.headers.range !== undefined) {
        // Range is unsupported in v1; authorized callers get 416, no storage.
        return this.empty(res, 416);
      }
      let object: GetObjectResult;
      try {
        object = await this.storage.getStream({
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
      // Client gone at/after acquisition: destroy the stream, no response.
      if (abort.signal.aborted) {
        object.stream.destroy();
        return;
      }
      // Once streaming, sendStream owns the close listener until the
      // stream settles; the finally must not remove it early.
      this.sendStream(res, object, abort, onDisconnected);
      streaming = true;
    } finally {
      if (!streaming) res.off('close', onDisconnected);
    }
  }

  /** Shared authorization phase for both routes: resolves the closed
   *  result — denied is returned to the caller for the shared 404 — while
   *  an unavailable result or unexpected rejection maps to the safe 503;
   *  null means a response was already sent or the client is gone. */
  private async authorizeOrRespond(
    res: Response,
    abort: AbortController,
    rawToken: string,
  ): Promise<Exclude<
    ReceiptCapabilityAuthorization,
    { kind: 'unavailable' }
  > | null> {
    try {
      const authorization = await this.authorizer.authorize(rawToken);
      // Client gone during authorization: no storage, no response.
      if (abort.signal.aborted) return null;
      if (authorization.kind !== 'unavailable') return authorization;
    } catch {
      // Fail-closed, but a disconnected client gets no response.
      if (abort.signal.aborted) return null;
    }
    this.unavailable(res);
    return null;
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

  /** WU6E1 GET streaming: the exact safe header set with a fixed non-PII
   *  filename, then one pipe of the authorized object stream. A disconnect
   *  destroys the stream via the abort signal and removes the exact close
   *  listener; an async stream failure before any byte is written maps to
   *  the safe 503, and after the headers are committed it terminates the
   *  connection — never a second response, body, or detail. */
  private sendStream(
    res: Response,
    object: GetObjectResult,
    abort: AbortController,
    onDisconnected: () => void,
  ): void {
    const stream = object.stream;
    let finalized = false;
    const onAbort = (): void => {
      stream.destroy();
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      abort.signal.removeEventListener('abort', onAbort);
      stream.off('error', onStreamError);
      stream.off('close', finalize);
      res.off('close', onDisconnected);
    };
    const onStreamError = (): void => {
      finalize();
      if (abort.signal.aborted) return;
      if (res.headersSent) res.destroy();
      else {
        // Pre-header failure: drop staged metadata; the safe 503 has none.
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Disposition');
        this.unavailable(res);
      }
    };
    stream.on('error', onStreamError);
    stream.once('close', finalize);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    res.setHeader('Content-Type', object.mimeType);
    res.setHeader('Content-Length', String(object.byteCount));
    // MIME is validated to exactly image/jpeg|image/png by the storage port.
    const filename =
      object.mimeType === 'image/png' ? 'receipt.png' : 'receipt.jpg';
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.status(200);
    stream.pipe(res);
  }
}
