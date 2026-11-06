import { createHmac } from 'node:crypto';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignatureGuard, readVerifiedWebhookSnapshot } from './signature.guard';

const secret = 'local-synthetic-key';
const bytes = Buffer.from('¡customer inbound 🐶!');
function fixture() {
  const config = new ConfigService({ meta: { appSecret: secret } });
  const req = {
    rawBody: Buffer.from(bytes),
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`,
    },
  };
  const guard = new SignatureGuard(config);
  const verify = () =>
    guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext);
  return { req, verify };
}
afterEach(() => jest.useRealTimers());

// Human decisions are always on: every verified request gets a snapshot.
it('always publishes a frozen verified snapshot', () => {
  jest.useFakeTimers({ now: new Date('2026-07-01T12:00:00.000Z') });
  const { req, verify } = fixture();
  expect(verify()).toBe(true);
  const snapshot = readVerifiedWebhookSnapshot(req);
  expect(snapshot).toEqual({
    rawBodyBase64: bytes.toString('base64'),
    observedAt: '2026-07-01T12:00:00.000Z',
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  req.rawBody.fill(0);
  expect(readVerifiedWebhookSnapshot(req)).toBe(snapshot);
  expect(snapshot?.rawBodyBase64).toBe(bytes.toString('base64'));
  expect(readVerifiedWebhookSnapshot({ ...req })).toBeNull();
});
it('revokes the snapshot on an invalid MAC', () => {
  const { req, verify } = fixture();
  expect(verify()).toBe(true);
  expect(readVerifiedWebhookSnapshot(req)).not.toBeNull();
  req.headers['x-hub-signature-256'] = `sha256=${'00'.repeat(32)}`;
  expect(verify).toThrow(UnauthorizedException);
  expect(readVerifiedWebhookSnapshot(req)).toBeNull();
});
