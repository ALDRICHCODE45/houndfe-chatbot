import { Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import type {
  MetaMediaPort,
  ValidatedMediaFile,
} from '../../receipt-media/domain/meta-media.port';
import type {
  ProductImageDescriberPort,
  ProductImageMimeType,
  ProductImageRecognition,
} from '../domain/product-image';
import { describeError } from '../../common/log-safe';

/** Overall bound on the Meta metadata + download hops (each hop also has
 * its own configured timeout inside the client). */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;

const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set<ProductImageMimeType>(
  ['image/jpeg', 'image/png'],
);

export interface ProductImageRecognitionOptions {
  readFile?: (path: string) => Promise<Buffer>;
  downloadTimeoutMs?: number;
}

export interface ProductImageRecognitionInput {
  providerMediaId: string;
  declaredMimeType: string;
}

/**
 * S5: downloads a customer photo through the receipt-media Meta client
 * (allowed hosts, size and structure limits) and describes it with the
 * vision describer. Never throws; the temp file is always cleaned up.
 */
export class ProductImageRecognitionService {
  private readonly logger = new Logger(ProductImageRecognitionService.name);
  private readonly readFile: (path: string) => Promise<Buffer>;
  private readonly downloadTimeoutMs: number;

  constructor(
    private readonly meta: MetaMediaPort,
    private readonly describer: ProductImageDescriberPort,
    options: ProductImageRecognitionOptions = {},
  ) {
    this.readFile = options.readFile ?? ((path) => fs.readFile(path));
    this.downloadTimeoutMs =
      options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  async recognize(
    input: ProductImageRecognitionInput,
  ): Promise<ProductImageRecognition> {
    if (!SUPPORTED_MIME_TYPES.has(input.declaredMimeType)) {
      return { kind: 'unavailable', reason: 'unsupported' };
    }
    const mimeType = input.declaredMimeType as ProductImageMimeType;
    let file: ValidatedMediaFile | undefined;
    try {
      file = await this.meta.resolveAndDownload({
        providerMediaId: input.providerMediaId,
        declaredMimeType: mimeType,
        signal: AbortSignal.timeout(this.downloadTimeoutMs),
      });
      const bytes = await this.readFile(file.filePath);
      return await this.describer.describe({ bytes, mimeType });
    } catch (error) {
      this.logger.warn(
        `Product image recognition failed: ${describeError(error)}`,
      );
      return { kind: 'unavailable', reason: 'error' };
    } finally {
      await file?.cleanup().catch(() => undefined);
    }
  }
}
