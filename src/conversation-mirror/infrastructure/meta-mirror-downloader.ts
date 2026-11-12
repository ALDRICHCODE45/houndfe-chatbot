import { MetaMediaError } from '../../receipt-media/domain/meta-media.port';
import {
  metaHttpStatusOf,
  type MetaMediaClient,
} from '../../receipt-media/infrastructure/meta-media.client';
import type {
  MirrorMetaDownloader,
  MirrorSourceFailure,
  MirrorSourceResult,
  DownloadedMirrorFile,
} from '../domain/mirror-media';
import { MIRROR_MEDIA_PROFILE } from './mirror-media-profile';

/** IN media: the receipt-media Meta client (stream to a mode-0600 temp file,
 *  10 MiB cap, byte sniffing, sha256) under the wider mirror profile. Failures
 *  are mapped to what the mirror reacts to; nothing carries the media id. */
export class MetaMirrorDownloader implements MirrorMetaDownloader {
  constructor(
    private readonly client: Pick<MetaMediaClient, 'downloadWithProfile'>,
  ) {}

  async download(input: {
    providerMediaId: string;
    signal: AbortSignal;
  }): Promise<MirrorSourceResult<DownloadedMirrorFile>> {
    try {
      const file = await this.client.downloadWithProfile(
        { providerMediaId: input.providerMediaId, signal: input.signal },
        MIRROR_MEDIA_PROFILE,
      );
      return {
        kind: 'ok',
        value: {
          filePath: file.filePath,
          mimeType: file.mimeType,
          byteCount: file.byteCount,
          sha256Hex: file.sha256.toString('hex'),
          cleanup: () => file.cleanup(),
        },
      };
    } catch (error) {
      return mapMetaError(error);
    }
  }
}

function mapMetaError(error: unknown): MirrorSourceFailure {
  if (!(error instanceof MetaMediaError))
    return { kind: 'park', reason: 'unexpected_response' };
  switch (error.code) {
    case 'UNSUPPORTED_MIME':
    case 'MIME_MISMATCH':
      return { kind: 'unsupported', reason: 'type_not_allowed' };
    case 'INVALID_MEDIA_SIZE':
      return { kind: 'unsupported', reason: 'too_large' };
    case 'HTTP_PERMANENT': {
      const status = metaHttpStatusOf(error);
      // An expired/invalid Meta token is systemic: stop, never a silent
      // UNSUPPORTED for every message.
      if (status === 401 || status === 403)
        return { kind: 'stop', reason: 'source_unauthorized' };
      return { kind: 'unsupported', reason: 'media_unavailable' };
    }
    case 'FILE_IO_FAILURE':
      return { kind: 'retry', cause: 'local_io' };
    case 'ABORTED':
      return { kind: 'retry', cause: 'aborted' };
    case 'HTTP_RETRYABLE':
    case 'NETWORK_FAILURE':
    case 'TIMEOUT':
      return { kind: 'retry', cause: 'source_transient' };
    default:
      // Structure codes cannot occur under this profile (no validate hook).
      return { kind: 'unsupported', reason: 'type_not_allowed' };
  }
}
