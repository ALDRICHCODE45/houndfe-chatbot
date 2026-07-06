import { envValidationSchema } from './env.validation';

/**
 * Unit tests for the Joi env validation schema.
 * These exercise the schema directly — no NestJS wiring needed.
 *
 * Tasks: 1.2, 1.3, 1.4, 2.1
 */
describe('envValidationSchema', () => {
  const validEnv = {
    META_VERIFY_TOKEN: 'my_verify_token',
    META_APP_SECRET: 'my_app_secret',
    META_ACCESS_TOKEN: 'my_access_token',
    META_PHONE_NUMBER_ID: '1234567890',
    CHATBOT_API_BASE_URL: 'https://api.example.com',
    SERVICE_KEY: 'svc_my_service_key',
    CHATBOT_API_BRANCH_ID: 'branch-uuid-1234',
    AI_GATEWAY_API_KEY: 'gateway-key-abc',
    LLM_MODEL: 'anthropic/claude-sonnet-4.5',
    DATABASE_URL: 'postgres://houndfe:houndfe@localhost:5432/houndfe_chatbot',
  };

  // ─── Task 1.2 ─────────────────────────────────────────────────────────────
  describe('META_VERIFY_TOKEN', () => {
    it('rejects when META_VERIFY_TOKEN is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_VERIFY_TOKEN;

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('META_VERIFY_TOKEN')),
      ).toBe(true);
    });

    it('accepts when META_VERIFY_TOKEN is a non-empty string', () => {
      const { error } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
  });

  // ─── Task 1.3 ─────────────────────────────────────────────────────────────
  describe('CHATBOT_API_BASE_URL', () => {
    it('rejects when CHATBOT_API_BASE_URL is not a valid URL', () => {
      const env = { ...validEnv, CHATBOT_API_BASE_URL: 'not-a-url' };

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('CHATBOT_API_BASE_URL')),
      ).toBe(true);
    });

    it('accepts when CHATBOT_API_BASE_URL is a valid HTTPS URL', () => {
      const env = {
        ...validEnv,
        CHATBOT_API_BASE_URL: 'https://backend.houndfe.com',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
  });

  // ─── Task 1.4 ─────────────────────────────────────────────────────────────
  describe('SERVICE_KEY', () => {
    it('rejects when SERVICE_KEY does not start with svc_', () => {
      const env = { ...validEnv, SERVICE_KEY: 'invalid_key_without_prefix' };

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('SERVICE_KEY'))).toBe(
        true,
      );
    });

    it('accepts when SERVICE_KEY starts with svc_', () => {
      const env = { ...validEnv, SERVICE_KEY: 'svc_abc123' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
  });

  // ─── Additional required vars ────────────────────────────────────────────
  describe('other required vars', () => {
    it('rejects when META_APP_SECRET is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_APP_SECRET;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('META_APP_SECRET')),
      ).toBe(true);
    });

    it('rejects when META_ACCESS_TOKEN is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_ACCESS_TOKEN;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('META_ACCESS_TOKEN')),
      ).toBe(true);
    });

    it('rejects when META_PHONE_NUMBER_ID is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_PHONE_NUMBER_ID;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('META_PHONE_NUMBER_ID')),
      ).toBe(true);
    });

    it('rejects when CHATBOT_API_BRANCH_ID is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).CHATBOT_API_BRANCH_ID;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('CHATBOT_API_BRANCH_ID')),
      ).toBe(true);
    });
  });

  // ─── Optional vars defaults ────────────────────────────────────────────────
  describe('optional vars', () => {
    it('rejects when META_GRAPH_API_BASE_URL is not a valid URI', () => {
      const env = {
        ...validEnv,
        META_GRAPH_API_BASE_URL: 'not-a-uri',
      };

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('META_GRAPH_API_BASE_URL')),
      ).toBe(true);
    });

    it('applies META_GRAPH_API_BASE_URL default when absent', () => {
      const { error, value } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      }) as { error?: undefined; value: Record<string, unknown> };
      expect(error).toBeUndefined();
      expect(value.META_GRAPH_API_BASE_URL).toBe(
        'https://graph.facebook.com/v23.0',
      );
    });

    it('allows PORT to be absent (defaults to 3000)', () => {
      const { error, value } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      }) as { error?: undefined; value: Record<string, unknown> };
      expect(error).toBeUndefined();
      expect(value.PORT).toBe(3000);
    });
  });

  // ─── LLM agent env vars ───────────────────────────────────────────────────
  describe('LLM env vars', () => {
    it('rejects when AI_GATEWAY_API_KEY is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).AI_GATEWAY_API_KEY;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('AI_GATEWAY_API_KEY')),
      ).toBe(true);
    });

    it('rejects when LLM_MODEL is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).LLM_MODEL;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('LLM_MODEL'))).toBe(
        true,
      );
    });

    it('rejects LLM_MAX_STEPS below 1', () => {
      const env = { ...validEnv, LLM_MAX_STEPS: '0' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('LLM_MAX_STEPS'))).toBe(
        true,
      );
    });

    it('rejects non-integer LLM_HISTORY_TURNS', () => {
      const env = { ...validEnv, LLM_HISTORY_TURNS: '3.5' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('LLM_HISTORY_TURNS')),
      ).toBe(true);
    });

    it('applies defaults for optional LLM knobs when absent', () => {
      const { error, value } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      }) as { error?: undefined; value: Record<string, unknown> };
      expect(error).toBeUndefined();
      expect(value.LLM_MAX_STEPS).toBe(3);
      expect(value.LLM_HISTORY_TURNS).toBe(12);
      expect(value.LLM_MONTHLY_TOKEN_CEILING).toBe(8_000_000);
      expect(value.LLM_IDLE_TIMEOUT_MS).toBe(10_800_000);
    });
  });

  // ─── Task 2.1: Database env vars (durable conversation store) ───────────
  describe('DATABASE_URL / DB_POOL_MAX', () => {
    it('rejects when DATABASE_URL is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).DATABASE_URL;

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('DATABASE_URL'))).toBe(
        true,
      );
    });

    it('rejects when DATABASE_URL is malformed (not a URI)', () => {
      const env = { ...validEnv, DATABASE_URL: 'not-a-uri' };

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('DATABASE_URL'))).toBe(
        true,
      );
    });

    it('applies DB_POOL_MAX default of 5 when absent', () => {
      const { error, value } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      }) as { error?: undefined; value: Record<string, unknown> };
      expect(error).toBeUndefined();
      expect(value.DB_POOL_MAX).toBe(5);
    });

    it('accepts DATABASE_URL as a valid URI', () => {
      const env = {
        ...validEnv,
        DATABASE_URL: 'postgres://u:p@db.example.com:5432/x',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('rejects DB_POOL_MAX below 1', () => {
      const env = { ...validEnv, DB_POOL_MAX: '0' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('DB_POOL_MAX'))).toBe(
        true,
      );
    });
  });
});
