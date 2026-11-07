import type {
  MetaMediaPort,
  ValidatedMediaFile,
} from '../../receipt-media/domain/meta-media.port';
import type {
  ProductImageDescriberPort,
  ProductImageDescription,
} from '../domain/product-image';
import { ProductImageRecognitionService } from './product-image-recognition.service';

const DESCRIPTION: ProductImageDescription = {
  kind: 'product',
  brand: 'Whiskas',
  productName: null,
  productType: 'alimento húmedo',
  species: 'gato',
  size: '85 g',
  flavorOrVariant: 'pollo',
  labelText: null,
  searchQueries: ['Whiskas pollo'],
  confidence: 'medium',
};

function harness(overrides: { download?: jest.Mock; describe?: jest.Mock }) {
  const cleanup = jest.fn().mockResolvedValue(undefined);
  const file: ValidatedMediaFile = {
    filePath: '/tmp/x.jpg',
    mimeType: 'image/jpeg',
    byteCount: 3,
    providerDeclaredBytes: 3,
    sha256: Buffer.alloc(32),
    cleanup,
  };
  const download = overrides.download ?? jest.fn().mockResolvedValue(file);
  const describe =
    overrides.describe ?? jest.fn().mockResolvedValue(DESCRIPTION);
  const readFile = jest.fn().mockResolvedValue(Buffer.from([1, 2, 3]));
  const meta: MetaMediaPort = { resolveAndDownload: download };
  const describer: ProductImageDescriberPort = { describe };
  const service = new ProductImageRecognitionService(meta, describer, {
    readFile,
  });
  return { service, download, describe, readFile, cleanup };
}

describe('ProductImageRecognitionService', () => {
  it('downloads the media, describes its bytes and cleans the temp file', async () => {
    const h = harness({});

    await expect(
      h.service.recognize({
        providerMediaId: 'media-1',
        declaredMimeType: 'image/jpeg',
      }),
    ).resolves.toEqual(DESCRIPTION);

    expect(h.download).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMediaId: 'media-1',
        declaredMimeType: 'image/jpeg',
      }),
    );
    expect(h.readFile).toHaveBeenCalledWith('/tmp/x.jpg');
    expect(h.describe).toHaveBeenCalledWith({
      bytes: Buffer.from([1, 2, 3]),
      mimeType: 'image/jpeg',
    });
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable:unsupported for a non JPEG/PNG image without downloading', async () => {
    const h = harness({});

    await expect(
      h.service.recognize({
        providerMediaId: 'media-1',
        declaredMimeType: 'image/webp',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'unsupported' });
    expect(h.download).not.toHaveBeenCalled();
  });

  it('returns unavailable:error when the download fails (never throws)', async () => {
    const h = harness({
      download: jest.fn().mockRejectedValue(new Error('META_TRANSPORT')),
    });

    await expect(
      h.service.recognize({
        providerMediaId: 'media-1',
        declaredMimeType: 'image/png',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'error' });
    expect(h.describe).not.toHaveBeenCalled();
  });

  it('still cleans the temp file when the describer throws', async () => {
    const h = harness({
      describe: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(
      h.service.recognize({
        providerMediaId: 'media-1',
        declaredMimeType: 'image/jpeg',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'error' });
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
});
