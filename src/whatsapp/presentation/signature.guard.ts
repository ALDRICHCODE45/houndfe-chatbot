import * as crypto from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

const SIGNATURE_HEADER_PREFIX = 'sha256=';

@Injectable()
export class SignatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest>();
    const signatureHeader = this.readSignatureHeader(request);
    const receivedDigest = Buffer.from(
      signatureHeader.slice(SIGNATURE_HEADER_PREFIX.length),
      'hex',
    );
    const expectedDigest = Buffer.from(
      this.computeDigest(request.rawBody),
      'hex',
    );

    if (receivedDigest.length !== expectedDigest.length) {
      throw new UnauthorizedException('Invalid X-Hub-Signature-256 header');
    }

    if (!crypto.timingSafeEqual(receivedDigest, expectedDigest)) {
      throw new UnauthorizedException('Invalid X-Hub-Signature-256 header');
    }

    return true;
  }

  private computeDigest(rawBody: Buffer | undefined): string {
    if (!Buffer.isBuffer(rawBody)) {
      throw new UnauthorizedException(
        'Missing raw request body for signature verification',
      );
    }

    const appSecret = this.configService.getOrThrow<string>('meta.appSecret');

    return crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  }

  private readSignatureHeader(request: RawBodyRequest): string {
    const header = request.headers['x-hub-signature-256'];

    if (
      typeof header !== 'string' ||
      !header.startsWith(SIGNATURE_HEADER_PREFIX)
    ) {
      throw new UnauthorizedException('Missing X-Hub-Signature-256 header');
    }

    return header;
  }
}
