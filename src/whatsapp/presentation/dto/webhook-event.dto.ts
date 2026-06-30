import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class WebhookMessageTextDto {
  @IsOptional()
  @IsString()
  body?: string;
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
}

export class WebhookContactDto {
  @IsOptional()
  @IsString()
  wa_id?: string;
}

export class WebhookValueDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WebhookContactDto)
  contacts?: WebhookContactDto[];

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
