import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Optional,
  InternalServerErrorException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { WebhookEventDto } from './dto/webhook-event.dto';
import { WebhookVerifyDto } from './dto/webhook-verify.dto';
import { SignatureGuard, readVerifiedWebhookSnapshot } from './signature.guard';
import { RestockInboundCapture } from '../application/restock-inbound-capture';

@Controller()
export class WebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    // Optional only for default-off composition; enabled requires a future factory.
    @Optional() private readonly restockCapture?: RestockInboundCapture,
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
    @Req() request?: Request,
  ): Promise<{ received: true }> {
    if (this.configService.get('humanDecisions.restockEnabled') === true) {
      const snapshot = request ? readVerifiedWebhookSnapshot(request) : null;
      if (!snapshot || !this.restockCapture) {
        throw new InternalServerErrorException();
      }
      const result = await this.restockCapture.capture(snapshot);
      if (result.action !== 'captured') {
        throw new InternalServerErrorException();
      }
      // Capture is not send authorization; retain the original dispatcher boundary.
      await this.webhookDispatcher.dispatch(result.event);
    } else {
      await this.webhookDispatcher.dispatch(event);
    }

    return { received: true };
  }
}
