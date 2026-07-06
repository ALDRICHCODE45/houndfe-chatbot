import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { ConversationModule } from './conversation.module';
import { CONVERSATION_STORE } from './domain/conversation-store';
import { PostgresConversationStore } from './infrastructure/postgres-conversation.store';

/**
 * Integration tests for ConversationModule wiring.
 *
 * Spec scenarios covered:
 *   - 6.1: Boot resolves CONVERSATION_STORE to the durable
 *     PostgresConversationStore (not the in-memory fallback).
 *
 * AgentRunner source untouched (R6) — verified by separate
 * `git diff --stat src/llm-agent/` returning zero lines during the
 * commit phase (task 6.5).
 */
describe('ConversationModule binding', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const MANAGED_KEYS = [
    'META_VERIFY_TOKEN',
    'META_APP_SECRET',
    'META_ACCESS_TOKEN',
    'META_PHONE_NUMBER_ID',
    'CHATBOT_API_BASE_URL',
    'SERVICE_KEY',
    'CHATBOT_API_BRANCH_ID',
    'AI_GATEWAY_API_KEY',
    'LLM_MODEL',
    'DATABASE_URL',
  ];

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, {
      META_VERIFY_TOKEN: 't',
      META_APP_SECRET: 's',
      META_ACCESS_TOKEN: 'a',
      META_PHONE_NUMBER_ID: '1',
      CHATBOT_API_BASE_URL: 'https://api.example.com',
      SERVICE_KEY: 'svc_x',
      CHATBOT_API_BRANCH_ID: 'b',
      AI_GATEWAY_API_KEY: 'g',
      LLM_MODEL: 'm',
      DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    });
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
  });

  it('resolves CONVERSATION_STORE to PostgresConversationStore (not in-memory)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), DatabaseModule, ConversationModule],
    })
      .overrideProvider(PG_POOL)
      .useValue({
        // Stubbed pool: wiring check only. The adapter's real SQL is
        // exercised in postgres-conversation.store.spec.ts (Testcontainers).
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      })
      .compile();

    const store = moduleRef.get(CONVERSATION_STORE);
    expect(store).toBeInstanceOf(PostgresConversationStore);

    await moduleRef.close();
  });
});