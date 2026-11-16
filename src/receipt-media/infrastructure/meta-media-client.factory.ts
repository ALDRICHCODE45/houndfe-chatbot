/** One construction path for every Meta media consumer (receipts, product
 *  images, conversation mirror): the same configuration keys, so the origin
 *  policy, timeouts and allowlist can never drift between modules. */
import type { ConfigService } from '@nestjs/config';
import {
  MetaMediaClient,
  type MetaMediaClientConfig,
  type MetaMediaClientDeps,
} from './meta-media.client';

export function metaMediaClientConfigFrom(
  config: ConfigService,
): MetaMediaClientConfig {
  return {
    graphApiBaseUrl: config.get<string>('meta.graphApiBaseUrl') ?? '',
    allowedHosts: config.get<string[]>('receiptMedia.meta.allowedHosts') ?? [],
    metadataTimeoutMs:
      config.get<number>('receiptMedia.meta.metadataTimeoutMs') ?? 0,
    downloadTimeoutMs:
      config.get<number>('receiptMedia.meta.downloadTimeoutMs') ?? 0,
  };
}

export function createMetaMediaClient(
  config: ConfigService,
  deps: MetaMediaClientDeps = {},
): MetaMediaClient {
  return new MetaMediaClient(
    metaMediaClientConfigFrom(config),
    () => config.get<string>('meta.accessToken') ?? '',
    deps,
  );
}
