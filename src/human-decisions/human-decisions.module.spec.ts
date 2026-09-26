import {
  Inject,
  Injectable,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { MetaWhatsappSender } from '../whatsapp/infrastructure/meta-whatsapp.sender';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import {
  RESTOCK_INTAKE_SERVICE,
  RestockIntakeService,
} from './application/restock-intake.service';
import {
  RESTOCK_POST_LEDGER,
  type RestockPostLedgerPort,
} from './domain/restock-post-ledger';
import {
  SHARED_RESERVATION,
  type SharedReservationPort,
} from './domain/shared-reservation';
import {
  SHARED_ROUTE_MARKERS,
  type SharedRouteMarkersPort,
} from './domain/shared-route-markers';
import { HumanDecisionsModule } from './human-decisions.module';
import { PostgresRestockPostLedgerStore } from './infrastructure/postgres-restock-post-ledger.store';
import { PostgresSharedReservationStore } from './infrastructure/postgres-shared-reservation.store';
import { PostgresSharedRouteMarkersStore } from './infrastructure/postgres-shared-route-markers.store';

/**
 * Synthetic DI wiring test for HumanDecisionsModule: it proves every token
 * resolves to exactly one inert adapter/coordinator and is exported to an
 * importing module, using a fake PG_POOL and a fake CHATBOT_API_CLIENT so no
 * connection is opened, no SQL is issued, and no API op runs during module init.
 */
@Injectable()
class ReservationConsumer {
  constructor(
    @Inject(SHARED_RESERVATION) readonly port: SharedReservationPort,
  ) {}
}

@Module({
  imports: [HumanDecisionsModule],
  providers: [ReservationConsumer],
})
class ConsumerModule {}

@Injectable()
class HumanDecisionsConsumer {
  constructor(
    @Inject(SHARED_RESERVATION) readonly reservations: SharedReservationPort,
    @Inject(SHARED_ROUTE_MARKERS) readonly markers: SharedRouteMarkersPort,
    @Inject(RESTOCK_POST_LEDGER) readonly ledger: RestockPostLedgerPort,
    @Inject(RESTOCK_INTAKE_SERVICE) readonly intake: RestockIntakeService,
  ) {}
}

@Module({
  imports: [HumanDecisionsModule],
  providers: [HumanDecisionsConsumer],
})
class TokensConsumerModule {}

const fakePool = {
  connect: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
  end: jest.fn().mockResolvedValue(undefined),
};

/** The two ops the coordinator touches; module init must call neither. */
const fakeClient = {
  getStock: jest.fn(),
  submitRestockIntake: jest.fn(),
} as unknown as ChatbotApiClient;

const compile = (imports: NonNullable<ModuleMetadata['imports']>) =>
  Test.createTestingModule({ imports })
    .overrideProvider(ConfigService)
    .useValue({ get: () => undefined })
    .overrideProvider(MetaWhatsappSender)
    .useValue({})
    .overrideProvider(WHATSAPP_SENDER)
    .useValue({ sendText: jest.fn() })
    .overrideProvider(PG_POOL)
    .useValue(fakePool)
    .overrideProvider(ChatbotApiHttpClient)
    .useValue({})
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue(fakeClient)
    .compile();

const inert = () => {
  expect(fakePool.connect).not.toHaveBeenCalled();
  expect(fakePool.query).not.toHaveBeenCalled();
  expect(fakeClient.getStock).not.toHaveBeenCalled();
  expect(fakeClient.submitRestockIntake).not.toHaveBeenCalled();
};

describe('HumanDecisionsModule binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('binds SHARED_RESERVATION to one inert PostgresSharedReservationStore', async () => {
    const moduleRef = await compile([DatabaseModule, HumanDecisionsModule]);
    const first = moduleRef.get<SharedReservationPort>(SHARED_RESERVATION);
    const second = moduleRef.get<SharedReservationPort>(SHARED_RESERVATION);
    expect(first).toBeInstanceOf(PostgresSharedReservationStore);
    expect(second).toBe(first);
    // Inert: resolving the token never opens a connection or issues SQL.
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(fakePool.query).not.toHaveBeenCalled();
    await moduleRef.close();
    expect(fakePool.end).toHaveBeenCalledTimes(1);
  });

  it('exports SHARED_RESERVATION to a consuming module', async () => {
    const moduleRef = await compile([ConsumerModule]);
    const consumer = moduleRef.get(ReservationConsumer);
    expect(consumer.port).toBeInstanceOf(PostgresSharedReservationStore);
    expect(fakePool.connect).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('binds the route-marker reader, the ledger, and the coordinator inertly', async () => {
    const moduleRef = await compile([DatabaseModule, HumanDecisionsModule]);
    expect(moduleRef.get(SHARED_ROUTE_MARKERS)).toBeInstanceOf(
      PostgresSharedRouteMarkersStore,
    );
    expect(moduleRef.get(RESTOCK_POST_LEDGER)).toBeInstanceOf(
      PostgresRestockPostLedgerStore,
    );
    expect(moduleRef.get(RESTOCK_INTAKE_SERVICE)).toBeInstanceOf(
      RestockIntakeService,
    );
    // Resolving every token still opens nothing and calls no API op.
    inert();
    await moduleRef.close();
  });

  it('injects the exact shared reservation, ledger, and client into the coordinator', async () => {
    const moduleRef = await compile([DatabaseModule, HumanDecisionsModule]);
    const service = moduleRef.get<RestockIntakeService>(RESTOCK_INTAKE_SERVICE);
    // SAFETY: the coordinator holds its collaborators on private fields, so
    // test-only introspection is the only way to prove the factory wiring.
    const internals = service as unknown as {
      reservations: unknown;
      ledger: unknown;
      client: unknown;
    };
    expect(internals.reservations).toBe(
      moduleRef.get<SharedReservationPort>(SHARED_RESERVATION),
    );
    expect(internals.ledger).toBe(
      moduleRef.get<RestockPostLedgerPort>(RESTOCK_POST_LEDGER),
    );
    expect(internals.client).toBe(fakeClient);
    expect(internals.reservations).toBeInstanceOf(
      PostgresSharedReservationStore,
    );
    inert();
    await moduleRef.close();
  });

  it('exports all four tokens to a consuming module', async () => {
    const moduleRef = await compile([TokensConsumerModule]);
    const consumer = moduleRef.get(HumanDecisionsConsumer);
    expect(consumer.reservations).toBeInstanceOf(
      PostgresSharedReservationStore,
    );
    expect(consumer.markers).toBeInstanceOf(PostgresSharedRouteMarkersStore);
    expect(consumer.ledger).toBeInstanceOf(PostgresRestockPostLedgerStore);
    expect(consumer.intake).toBeInstanceOf(RestockIntakeService);
    inert();
    await moduleRef.close();
  });
});
