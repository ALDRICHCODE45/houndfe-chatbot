import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class WebhookMessageTextDto {
  @IsOptional()
  @IsString()
  body?: string;
}

export class WebhookMessageMediaDto {
  @IsNotEmpty()
  @IsString()
  id!: string;

  @IsNotEmpty()
  @IsString()
  mime_type!: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  sha256?: string;
}

export class WebhookMessageDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookMessageTextDto)
  text?: WebhookMessageTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookMessageMediaDto)
  image?: WebhookMessageMediaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookMessageMediaDto)
  document?: WebhookMessageMediaDto;
}

export class WebhookContactDto {
  @IsOptional()
  @IsString()
  wa_id?: string;
}

/**
 * Metadata block Meta attaches to every webhook value. It carries the
 * `phone_number_id` and `display_phone_number` of the receiving WhatsApp
 * Business number — the human-handoff slice uses `phone_number_id` only
 * for observability; the discriminator remains `isOpsSender(from)` per
 * ADR-22.
 */
export class WebhookMetadataDto {
  @IsOptional()
  @IsString()
  display_phone_number?: string;

  @IsOptional()
  @IsString()
  phone_number_id?: string;
}

export class WebhookValueDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookContactDto)
  contacts?: WebhookContactDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookMetadataDto)
  metadata?: WebhookMetadataDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookMessageDto)
  messages?: WebhookMessageDto[];

  @IsOptional()
  @IsArray()
  statuses?: Array<Record<string, unknown>>;
}

export class WebhookChangeDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookValueDto)
  value?: WebhookValueDto;
}

export class WebhookEntryDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookChangeDto)
  changes?: WebhookChangeDto[];
}

export class WebhookEventDto {
  @IsOptional()
  @IsString()
  object?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookEntryDto)
  entry?: WebhookEntryDto[];
}
