export class WebhookVerifyDto {
  'hub.mode'!: string;
  'hub.verify_token'!: string;
  'hub.challenge'!: string;
}
