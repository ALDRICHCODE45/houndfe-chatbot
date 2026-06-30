import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { WebhookEventDto } from './dto/webhook-event.dto';
import { WebhookVerifyDto } from './dto/webhook-verify.dto';
import { SignatureGuard } from './signature.guard';

@Controller()
export class WebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  @Get('webhook')
  verify(@Query() query: WebhookVerifyDto): string {
    const expectedToken =
      this.configService.getOrThrow<string>('meta.verifyToken');

    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] === expectedToken
    ) {
      return query['hub.challenge'];
    }

    throw new ForbiddenException('Invalid webhook verify token');
  }

  @Post('webhook')
  @HttpCode(200)
  @UseGuards(SignatureGuard)
  async handleEvent(
    @Body() event: WebhookEventDto,
  ): Promise<{ received: true }> {
    await this.webhookDispatcher.dispatch(event);

    return { received: true };
  }
}
