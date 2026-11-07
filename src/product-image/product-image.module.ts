/** S5 product image recognition composition root: the vision describer over
 * the shared LlmCoreModule seams (same GENERATE_TEXT, model and cost guard
 * as the agent and the receipt pre-fill) and the receipt-media MetaMediaClient
 * built with the same config (allowed hosts, timeouts, size limits). */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CostGuardService } from '../llm-agent/application/cost-guard.service';
import {
  GENERATE_TEXT,
  type GenerateTextFn,
} from '../llm-agent/infrastructure/generate-text.provider';
import { LlmCoreModule } from '../llm-agent/infrastructure/llm-core.module';
import type { MetaMediaPort } from '../receipt-media/domain/meta-media.port';
import {
  MetaMediaClient,
  type MetaMediaClientConfig,
} from '../receipt-media/infrastructure/meta-media.client';
import { ProductImageRecognitionService } from './application/product-image-recognition.service';
import {
  PRODUCT_IMAGE_DESCRIBER,
  type ProductImageDescriberPort,
} from './domain/product-image';
import { LlmProductImageDescriberAdapter } from './infrastructure/llm-product-image-describer.adapter';

/** Same configuration as ReceiptMediaModule's META_MEDIA provider (that
 * token is module-private), so product photos get the identical host
 * allowlist, timeouts and size/structure validation. */
const metaMediaClient = (config: ConfigService): MetaMediaPort =>
  new MetaMediaClient(
    {
      graphApiBaseUrl: config.get<string>('meta.graphApiBaseUrl') ?? '',
      allowedHosts:
        config.get<string[]>('receiptMedia.meta.allowedHosts') ?? [],
      metadataTimeoutMs:
        config.get<number>('receiptMedia.meta.metadataTimeoutMs') ?? 0,
      downloadTimeoutMs:
        config.get<number>('receiptMedia.meta.downloadTimeoutMs') ?? 0,
    } satisfies MetaMediaClientConfig,
    () => config.get<string>('meta.accessToken') ?? '',
  );

@Module({
  imports: [ConfigModule, LlmCoreModule],
  providers: [
    {
      provide: PRODUCT_IMAGE_DESCRIBER,
      useFactory: (
        generateTextFn: GenerateTextFn,
        config: ConfigService,
        costGuard: CostGuardService,
      ): ProductImageDescriberPort =>
        new LlmProductImageDescriberAdapter(
          generateTextFn,
          config.get<string>('llm.model') ?? '',
          { costGuard },
        ),
      inject: [GENERATE_TEXT, ConfigService, CostGuardService],
    },
    {
      provide: ProductImageRecognitionService,
      useFactory: (
        config: ConfigService,
        describer: ProductImageDescriberPort,
      ): ProductImageRecognitionService =>
        new ProductImageRecognitionService(metaMediaClient(config), describer),
      inject: [ConfigService, PRODUCT_IMAGE_DESCRIBER],
    },
  ],
  exports: [ProductImageRecognitionService],
})
export class ProductImageModule {}
