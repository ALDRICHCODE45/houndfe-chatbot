import { IsString } from 'class-validator';

export class WebhookVerifyDto {
  @IsString()
  'hub.mode'!: string;

  @IsString()
  'hub.verify_token'!: string;

  @IsString()
  'hub.challenge'!: string;
}
