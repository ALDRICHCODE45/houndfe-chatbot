import { createHmac } from 'node:crypto';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignatureGuard, readVerifiedWebhookSnapshot } from './signature.guard';

const secret = 'local-synthetic-key';
const bytes = Buffer.from('¡customer inbound 🐶!');
function fixture(customerInboundEnabled: unknown, restockEnabled: unknown) {
  const config = new ConfigService({
    meta: { appSecret: secret },
    humanDecisions: { customerInboundEnabled, restockEnabled },
  });
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
  return { config, req, verify };
}
afterEach(() => jest.useRealTimers());

it.each([
  [false, false, false],
  [true, false, true],
  [false, true, true],
  [true, true, true],
  ['true', false, false],
  [undefined, undefined, false],
])('snapshot gate customer=%p restock=%p', (customer, restock, expected) => {
  jest.useFakeTimers({ now: new Date('2026-07-01T12:00:00.000Z') });
  const { req, verify } = fixture(customer, restock);
  expect(verify()).toBe(true);
  const snapshot = readVerifiedWebhookSnapshot(req);
  if (!expected) {
    expect(snapshot).toBeNull();
    return;
  }
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
it.each([false, true])(
  'rejects invalid MAC with customer capture enabled, restock=%p',
  (restock) => {
    const { req, verify } = fixture(true, restock);
    expect(verify()).toBe(true);
    expect(readVerifiedWebhookSnapshot(req)).not.toBeNull();
    req.headers['x-hub-signature-256'] = `sha256=${'00'.repeat(32)}`;
    expect(verify).toThrow(UnauthorizedException);
    expect(readVerifiedWebhookSnapshot(req)).toBeNull();
  },
);
it('revokes existing snapshot when both gates become disabled', () => {
  const { config, req, verify } = fixture(true, false);
  expect(verify()).toBe(true);
  expect(readVerifiedWebhookSnapshot(req)).not.toBeNull();
  config.set('humanDecisions.customerInboundEnabled', false);
  expect(verify()).toBe(true);
  expect(readVerifiedWebhookSnapshot(req)).toBeNull();
});
