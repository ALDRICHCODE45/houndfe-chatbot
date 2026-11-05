import {
  Body,
  Inject,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
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
import {
  CUSTOMER_INBOUND_CAPTURE,
  type CustomerInboundCapture,
} from '../infrastructure/customer-inbound-capture.provider';

@Controller()
export class WebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly restockCapture: RestockInboundCapture,
    @Inject(CUSTOMER_INBOUND_CAPTURE)
    private readonly customerCapture: CustomerInboundCapture,
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
    const snapshot = request ? readVerifiedWebhookSnapshot(request) : null;
    if (!snapshot) {
      throw new InternalServerErrorException();
    }
    const restock = await this.restockCapture.capture(snapshot);
    if (restock.action !== 'captured') {
      throw new InternalServerErrorException();
    }
    const dispatchEvent = restock.event;
    try {
      const result = await this.customerCapture(request);
      if (result.action !== 'captured')
        throw new InternalServerErrorException();
    } catch {
      // Do not expose storage details, retry, or dispatch after uncertain writes.
      throw new InternalServerErrorException();
    }
    // Capture is not send authorization; retain the original dispatcher boundary.
    await this.webhookDispatcher.dispatch(dispatchEvent);

    return { received: true };
  }
}
