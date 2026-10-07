import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import { PostgresCustomerInboundObservationStore } from '../../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import { HUMAN_HANDOFF_SERVICE_TOKEN } from '../../sale-flow/infrastructure/real-tool-registry';
import {
  RECENT_OUTBOUND,
  type RecentOutboundStore,
} from '../domain/recent-outbound.store';
import { captureCustomerInboundObservations } from '../application/customer-inbound-persistence';

export const CUSTOMER_INBOUND_CAPTURE = Symbol('CUSTOMER_INBOUND_CAPTURE');
export type CustomerInboundCapture = (
  request: unknown,
) => ReturnType<typeof captureCustomerInboundObservations>;

export const customerInboundCaptureProvider: FactoryProvider<CustomerInboundCapture> =
  {
    provide: CUSTOMER_INBOUND_CAPTURE,
    inject: [
      ConfigService,
      PG_POOL,
      HUMAN_HANDOFF_SERVICE_TOKEN,
      RECENT_OUTBOUND,
    ],
    useFactory: (
      config: ConfigService,
      pool: Pick<Pool, 'query'>,
      handoff: Pick<HumanHandoffService, 'isOpsSender'>,
      recent: Pick<RecentOutboundStore, 'isKnown'>,
    ): CustomerInboundCapture => {
      const store = new PostgresCustomerInboundObservationStore(pool);
      return (request) =>
        captureCustomerInboundObservations(
          request,
          {
            enabled: config.get('humanDecisions.customerInboundEnabled'),
            phone: config.get<string>('meta.phoneNumberId') ?? '',
            isOpsSender: (sender) => handoff.isOpsSender(sender),
            isKnownOutbound: (id) => recent.isKnown(id),
          },
          store,
        );
    },
  };
