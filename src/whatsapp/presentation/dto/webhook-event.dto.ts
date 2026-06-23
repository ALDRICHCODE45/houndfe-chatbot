export class WebhookMessageTextDto {
  body?: string;
}

export class WebhookMessageDto {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: WebhookMessageTextDto;
}

export class WebhookContactDto {
  wa_id?: string;
}

export class WebhookValueDto {
  contacts?: WebhookContactDto[];
  messages?: WebhookMessageDto[];
  statuses?: Array<Record<string, unknown>>;
}

export class WebhookChangeDto {
  value?: WebhookValueDto;
}

export class WebhookEntryDto {
  changes?: WebhookChangeDto[];
}

export class WebhookEventDto {
  object?: string;
  entry?: WebhookEntryDto[];
}
