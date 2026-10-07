import type { CustomerInboundObservationStore } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import {
  normalizeCustomerInboundObservation,
  type CustomerInboundObservation,
} from '../../human-decisions/domain/customer-inbound-observation';
import {
  prepareCustomerInboundObservations,
  type CustomerInboundCaptureOptions,
} from './customer-inbound-capture';

type CaptureResult =
  | Readonly<{ action: 'disabled' | 'hold' }>
  | Readonly<{
      action: 'captured';
      observations: readonly CustomerInboundObservation[];
    }>;

const HOLD = Object.freeze({ action: 'hold' } as const);

/** Default-off runtime capture authenticates the actual request's snapshot before
 * any write. Uses standalone store operations in batch order, without retries
 * or rollback: HOLD/throw may follow a durable prefix or an uncertain write.
 * Returned metadata grants no latestness, service-window or send permission.
 */
export async function captureCustomerInboundObservations(
  request: unknown,
  options: CustomerInboundCaptureOptions,
  store: CustomerInboundObservationStore,
): Promise<CaptureResult> {
  const prepared = prepareCustomerInboundObservations(request, options);
  if (prepared.action !== 'prepared') return prepared;
  const observations: CustomerInboundObservation[] = [];
  for (const input of prepared.observations) {
    const result = await store.record(input);
    if (!result || (result.kind !== 'recorded' && result.kind !== 'replay'))
      return HOLD;
    const stored = normalizeCustomerInboundObservation(result.observation);
    if (
      !stored ||
      stored.senderId !== input.senderId ||
      stored.receivingPhoneNumberId !== input.receivingPhoneNumberId ||
      stored.messageId !== input.messageId ||
      stored.providerTimestampSeconds !== input.providerTimestampSeconds ||
      (result.kind === 'recorded' && stored.observedAt !== input.observedAt)
    )
      return HOLD;
    observations.push(stored);
  }
  return Object.freeze({
    action: 'captured',
    observations: Object.freeze(observations),
  });
}
