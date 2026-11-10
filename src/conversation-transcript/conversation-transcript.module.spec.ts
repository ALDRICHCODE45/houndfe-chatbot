import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BackendOutboxService } from '../backend-outbox/application/backend-outbox.service';
import { BackendOutboxDrainLifecycle } from '../backend-outbox/backend-outbox.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { MetaWhatsappSender } from '../whatsapp/infrastructure/meta-whatsapp.sender';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { TranscriptPurgeWorker } from './application/transcript-purge.worker';
import {
  OUTBOUND_TRANSCRIPT_RECORDER,
  TranscriptRecorder,
} from './application/transcript-recorder';
import { ConversationTranscriptModule } from './conversation-transcript.module';
import { CONVERSATION_TRANSCRIPT } from './domain/transcript.port';
import { PostgresTranscriptStore } from './infrastructure/postgres-transcript.store';
import { TranscriptPurgeModule } from './transcript-purge.module';

const pool = () => ({
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
});

describe('ConversationTranscriptModule wiring (S1)', () => {
  it('binds the Postgres store and one recorder for inbound and outbound', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        ConversationTranscriptModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    expect(moduleRef.get(CONVERSATION_TRANSCRIPT)).toBeInstanceOf(
      PostgresTranscriptStore,
    );
    expect(moduleRef.get(OUTBOUND_TRANSCRIPT_RECORDER)).toBe(
      moduleRef.get(TranscriptRecorder),
    );
    // S1→S2: the recorder mirrors through the shared outbox service.
    expect(moduleRef.get(TranscriptRecorder)['outbox']).toBe(
      moduleRef.get(BackendOutboxService),
    );
    // Feature graphs never start the purge timer or the outbox drain.
    expect(() => moduleRef.get(TranscriptPurgeWorker)).toThrow();
    expect(() => moduleRef.get(BackendOutboxDrainLifecycle)).toThrow();
    await moduleRef.close();
  });

  it('the WhatsApp sender records through the shared recorder', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        WhatsappSenderModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    const sender = moduleRef.get<MetaWhatsappSender>(WHATSAPP_SENDER);
    expect(sender['transcript']).toBe(moduleRef.get(TranscriptRecorder));
    await moduleRef.close();
  });

  it('the purge module runs exactly one worker', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        TranscriptPurgeModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    expect(moduleRef.get(TranscriptPurgeWorker)).toBeInstanceOf(
      TranscriptPurgeWorker,
    );
    await moduleRef.close();
  });
});
