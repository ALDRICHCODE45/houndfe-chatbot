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
import {
  CUSTOMER_INBOUND_CAPTURE,
  type CustomerInboundCapture,
} from '../infrastructure/customer-inbound-capture.provider';

@Controller()
export class WebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    // Optional only for default-off composition; enabled requires a future factory.
    @Optional() private readonly restockCapture?: RestockInboundCapture,
    @Optional()
    @Inject(CUSTOMER_INBOUND_CAPTURE)
    private readonly customerCapture?: CustomerInboundCapture,
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
    let dispatchEvent = event;
    if (this.configService.get('humanDecisions.restockEnabled') === true) {
      const snapshot = request ? readVerifiedWebhookSnapshot(request) : null;
      if (!snapshot || !this.restockCapture) {
        throw new InternalServerErrorException();
      }
      const result = await this.restockCapture.capture(snapshot);
      if (result.action !== 'captured') {
        throw new InternalServerErrorException();
      }
      dispatchEvent = result.event;
    }
    if (
      this.configService.get('humanDecisions.customerInboundEnabled') === true
    ) {
      try {
        if (!this.customerCapture) throw new InternalServerErrorException();
        const result = await this.customerCapture(request);
        if (result.action !== 'captured')
          throw new InternalServerErrorException();
      } catch {
        // Do not expose storage details, retry, or dispatch after uncertain writes.
        throw new InternalServerErrorException();
      }
    }
    // Capture is not send authorization; retain the original dispatcher boundary.
    await this.webhookDispatcher.dispatch(dispatchEvent);

    return { received: true };
  }
}
