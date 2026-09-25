import * as Joi from 'joi';

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
    OPENAI_API_KEY: 'openai-key-abc',
    LLM_MODEL: 'anthropic/claude-sonnet-4.5',
    DATABASE_URL: 'postgres://houndfe:houndfe@localhost:5432/houndfe_chatbot',
    CHATBOT_API_CASHIER_USER_ID: '00000000-0000-4000-8000-000000000001',
    OPS_CHANNEL_PHONE: '5219999888777',
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
    it('rejects when OPENAI_API_KEY is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).OPENAI_API_KEY;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('OPENAI_API_KEY')),
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

  // CHATBOT_API_CASHIER_USER_ID -- task 1.1
  describe('CHATBOT_API_CASHIER_USER_ID', () => {
    it('rejects when CHATBOT_API_CASHIER_USER_ID is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).CHATBOT_API_CASHIER_USER_ID;

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(
        error!.details.some((d) =>
          d.path.includes('CHATBOT_API_CASHIER_USER_ID'),
        ),
      ).toBe(true);
    });

    it('rejects when CHATBOT_API_CASHIER_USER_ID is not a valid UUID', () => {
      const env = {
        ...validEnv,
        CHATBOT_API_CASHIER_USER_ID: 'cashier-1',
      };

      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(
        error!.details.some((d) =>
          d.path.includes('CHATBOT_API_CASHIER_USER_ID'),
        ),
      ).toBe(true);
    });

    it('accepts a valid UUID v4', () => {
      const env = {
        ...validEnv,
        CHATBOT_API_CASHIER_USER_ID: '00000000-0000-4000-8000-000000000001',
        OPS_CHANNEL_PHONE: '5219999888777',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
  });

  // ─── Task T3.1 / T3.2: human-handoff env vars ─────────────────────────
  describe('OPS_CHANNEL_PHONE / HUMAN_HANDOFF_ENABLED', () => {
    it('rejects when HUMAN_HANDOFF_ENABLED=true and OPS_CHANNEL_PHONE is missing', () => {
      const env: Record<string, string> = {
        ...validEnv,
        HUMAN_HANDOFF_ENABLED: 'true',
      };
      delete env.OPS_CHANNEL_PHONE;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.message.includes('OPS_CHANNEL_PHONE')),
      ).toBe(true);
    });

    it('rejects when OPS_CHANNEL_PHONE is an empty string (HUMAN_HANDOFF_ENABLED=true)', () => {
      const env = { ...validEnv, OPS_CHANNEL_PHONE: '' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects when OPS_CHANNEL_PHONE is not a digits-only string', () => {
      const env = { ...validEnv, OPS_CHANNEL_PHONE: 'not-a-phone' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('accepts OPS_CHANNEL_PHONE with an optional + prefix', () => {
      const env = { ...validEnv, OPS_CHANNEL_PHONE: '+5219999888777' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('accepts a valid OPS_CHANNEL_PHONE when HUMAN_HANDOFF_ENABLED is true (default)', () => {
      const env = { ...validEnv, OPS_CHANNEL_PHONE: '5219999888777' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('accepts missing OPS_CHANNEL_PHONE when HUMAN_HANDOFF_ENABLED is false', () => {
      const env: Record<string, string> = {
        ...validEnv,
        HUMAN_HANDOFF_ENABLED: 'false',
      };
      delete env.OPS_CHANNEL_PHONE;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('applies HUMAN_HANDOFF_ENABLED default true when absent', () => {
      const env: Record<string, string> = { ...validEnv };
      delete env.OPS_CHANNEL_PHONE;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      // Default is true so missing OPS_CHANNEL_PHONE is rejected.
      expect(error).toBeDefined();
    });
  });

  // ─── WU2A: experimental human-decisions RESTOCK gate ──────────────────
  describe('HUMAN_DECISIONS_RESTOCK_ENABLED', () => {
    const validate = (value: string | undefined) => {
      const env: Record<string, string | undefined> = { ...validEnv };
      if (value === undefined) {
        delete env.HUMAN_DECISIONS_RESTOCK_ENABLED;
      } else {
        env.HUMAN_DECISIONS_RESTOCK_ENABLED = value;
      }
      return envValidationSchema.validate(env, { abortEarly: false });
    };

    it('accepts an absent value and defaults it to "false"', () => {
      const result = validate(undefined);
      expect(result.error).toBeUndefined();
      const value = result.value as {
        HUMAN_DECISIONS_RESTOCK_ENABLED?: unknown;
      };
      expect(value.HUMAN_DECISIONS_RESTOCK_ENABLED).toBe('false');
    });

    it('accepts the exact strings "true" and "false"', () => {
      expect(validate('true').error).toBeUndefined();
      expect(validate('false').error).toBeUndefined();
    });

    it.each(['TRUE', 'True', '1', '0', 'yes', '', 'true '])(
      'rejects the ambiguous value %p so activation stays unambiguous',
      (value) => {
        const { error } = validate(value);
        expect(error).toBeDefined();
        expect(
          error?.details.some((d) =>
            d.path.includes('HUMAN_DECISIONS_RESTOCK_ENABLED'),
          ),
        ).toBe(true);
      },
    );
  });

  // ─── WU1C1 + WU1C2A: Receipt media conditional validation foundation ───
  // Disabled (default) MUST be permissive; enabled MUST strictly validate
  // the listed receipt-media fields. WU1C2A extends enabledBase once with
  // numeric timeout/concurrency/lease/poll/attach values and proves the
  // relational bounds at the same compactness budget.
  describe('RECEIPT_MEDIA_* conditional foundation (WU1C1+WU1C2A)', () => {
    const enabledBase = {
      ...validEnv,
      RECEIPT_MEDIA_ENABLED: 'true',
      RECEIPT_MEDIA_MAX_BYTES: '10485760',
      META_MEDIA_ALLOWED_HOSTS: 'graph.facebook.com,.meta.com',
      RECEIPT_STORAGE_ENDPOINT: 'https://s3.example.com',
      RECEIPT_STORAGE_REGION: 'us-east-1',
      RECEIPT_STORAGE_BUCKET: 'houndfe-receipts',
      RECEIPT_STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      RECEIPT_STORAGE_SECRET_ACCESS_KEY: 'redacted-secret-value',
      RECEIPT_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
      RECEIPT_MEDIA_METRICS_ENABLED: 'true',
      // WU15-1: dedicated metrics Bearer token — 64 hex chars from 32 random bytes.
      RECEIPT_MEDIA_METRICS_TOKEN:
        'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      // WU1C2A numeric relations: metadata=5s, download=30s,
      // concurrency=2, lease=exactly 60s, poll=1s, attach=30s.
      META_MEDIA_METADATA_TIMEOUT_MS: '5000',
      META_MEDIA_DOWNLOAD_TIMEOUT_MS: '30000',
      RECEIPT_MEDIA_WORKER_CONCURRENCY: '2',
      RECEIPT_MEDIA_WORKER_LEASE_MS: '60000',
      RECEIPT_MEDIA_WORKER_POLL_MS: '1000',
      CHATBOT_API_ATTACH_TIMEOUT_MS: '30000',
      // WU1C2B1: versioned keyring v1=32-byte "A" key, v2=32-byte "B" key; active=v2.
      RECEIPT_CAPABILITY_KEYS:
        '1:QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=,2:QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      RECEIPT_CAPABILITY_ACTIVE_VERSION: '2',
    };

    // ─── Disabled permissiveness ───────────────────────────────────────
    const disabledCases: Array<[string, Record<string, unknown>]> = [
      ['no receipt fields at all', { ...validEnv }],
      [
        'enabled=false with malformed max bytes',
        {
          ...validEnv,
          RECEIPT_MEDIA_ENABLED: 'false',
          RECEIPT_MEDIA_MAX_BYTES: 'not-an-int',
        },
      ],
      [
        'enabled=false with malformed allowed hosts',
        {
          ...validEnv,
          RECEIPT_MEDIA_ENABLED: 'false',
          META_MEDIA_ALLOWED_HOSTS: 'http://example.com:443/path',
        },
      ],
      [
        'enabled=false with malformed capability keyring + active version',
        {
          ...validEnv,
          RECEIPT_MEDIA_ENABLED: 'false',
          RECEIPT_CAPABILITY_KEYS: 'not-a-keyring',
          RECEIPT_CAPABILITY_ACTIVE_VERSION: 'not-an-int',
        },
      ],
    ];
    it.each(disabledCases)('disabled accepts: %s', (_label, env) => {
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    // ─── Valid enabled fixture ─────────────────────────────────────────
    it('accepts a complete valid enabled environment', () => {
      const { error } = envValidationSchema.validate(enabledBase, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    // ─── Missing required enabled fields ──────────────────────────────
    const enabledRequiredFields = [
      'RECEIPT_MEDIA_MAX_BYTES',
      'META_MEDIA_ALLOWED_HOSTS',
      'RECEIPT_STORAGE_ENDPOINT',
      'RECEIPT_STORAGE_REGION',
      'RECEIPT_STORAGE_BUCKET',
      'RECEIPT_STORAGE_ACCESS_KEY_ID',
      'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
      'RECEIPT_MEDIA_PUBLIC_BASE_URL',
      'RECEIPT_CAPABILITY_KEYS',
      'RECEIPT_CAPABILITY_ACTIVE_VERSION',
    ];
    it.each(enabledRequiredFields)(
      'rejects enabled with missing %s',
      (field) => {
        const env: Record<string, unknown> = { ...enabledBase };
        delete env[field];
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(error).toBeDefined();
        expect(error!.details.some((d) => d.path.includes(field))).toBe(true);
      },
    );
    it.each(enabledRequiredFields)('rejects enabled with empty %s', (field) => {
      const env = { ...enabledBase, [field]: '' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes(field))).toBe(true);
    });

    // ─── Exact max bytes ──────────────────────────────────────────────
    it.each(['10485759', '10485761', '0', 'abc'])(
      'rejects RECEIPT_MEDIA_MAX_BYTES=%s',
      (value) => {
        const env = { ...enabledBase, RECEIPT_MEDIA_MAX_BYTES: value };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(error).toBeDefined();
      },
    );
    it('accepts RECEIPT_MEDIA_MAX_BYTES=10485760 exactly', () => {
      const env = { ...enabledBase, RECEIPT_MEDIA_MAX_BYTES: '10485760' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    // ─── HTTPS-only URLs ──────────────────────────────────────────────
    const urlFields = [
      'RECEIPT_STORAGE_ENDPOINT',
      'RECEIPT_MEDIA_PUBLIC_BASE_URL',
    ];
    it.each(urlFields)('rejects http:// scheme for %s', (field) => {
      const env = { ...enabledBase, [field]: 'http://example.com' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });
    it.each(urlFields)('rejects malformed %s', (field) => {
      const env = { ...enabledBase, [field]: 'not-a-url' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    // ─── Host labels: exact vs leading-dot suffix vs malformed ────────
    const acceptedHosts = [
      'graph.facebook.com',
      '.meta.com',
      'a.b.c.example.com',
      'sub.example.com,.suffix.example',
      'localhost',
    ];
    const rejectedHosts = [
      'https://example.com',
      'example.com:443',
      'user@example.com',
      'example.com/path',
      '-bad.example.com',
      'example..com',
      'invalid*char.example.com',
      '',
      '.',
      'example.com.',
      'a-.example.com',
    ];
    it.each(acceptedHosts)('accepts META_MEDIA_ALLOWED_HOSTS=%s', (value) => {
      const env = { ...enabledBase, META_MEDIA_ALLOWED_HOSTS: value };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
    it.each(rejectedHosts)('rejects META_MEDIA_ALLOWED_HOSTS=%s', (value) => {
      const env = { ...enabledBase, META_MEDIA_ALLOWED_HOSTS: value };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    // ─── Booleans: canonical vs arbitrary vs empty ─────────────────────
    const booleanFields = [
      'RECEIPT_STORAGE_FORCE_PATH_STYLE',
      'RECEIPT_MEDIA_METRICS_ENABLED',
    ];
    it.each(['true', 'false'] as const)(
      'accepts %s canonical booleans',
      (value) => {
        for (const field of booleanFields) {
          const env = { ...enabledBase, [field]: value };
          const { error } = envValidationSchema.validate(env, {
            abortEarly: false,
          });
          expect(error).toBeUndefined();
        }
      },
    );
    it.each(booleanFields)('rejects empty %s', (field) => {
      const env = { ...enabledBase, [field]: '' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });
    it.each(booleanFields)('rejects arbitrary value for %s', (field) => {
      const env = { ...enabledBase, [field]: 'yes' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    // ─── WU15-1: Independent metrics flag + dedicated token validation ─────
    // RECEIPT_MEDIA_METRICS_ENABLED is independently validated (not keyed on
    // RECEIPT_MEDIA_ENABLED); token is required ONLY when metrics is enabled.

    // Metrics disabled: any supplied token must still be valid 64hex.
    // RED: current schema accepts malformed tokens when disabled.
    it('rejects disabled metrics with supplied invalid-token (too short)', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_TOKEN: 'too-short',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects disabled metrics with supplied invalid-token (non-hex chars)', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_TOKEN:
          'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects disabled metrics with supplied 65-char token', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_TOKEN: 'a'.repeat(65),
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('accepts disabled metrics with absent RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_ENABLED: 'false',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('accepts disabled metrics with valid 64hex RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_TOKEN:
          'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    // Metrics disabled + enabled flag independently: valid token supplied with metrics=false → OK
    it('accepts disabled metrics with valid token even when metricsEnabled absent', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_METRICS_TOKEN:
          'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('accepts enabled metrics with valid token when RECEIPT_MEDIA_ENABLED=false', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_ENABLED: 'false',
        RECEIPT_MEDIA_METRICS_ENABLED: 'true',
        RECEIPT_MEDIA_METRICS_TOKEN:
          'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    // Metrics enabled: token is required
    it('rejects enabled metrics with missing RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...enabledBase,
      };
      delete (env as Record<string, unknown>).RECEIPT_MEDIA_METRICS_TOKEN;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) =>
          d.path.includes('RECEIPT_MEDIA_METRICS_TOKEN'),
        ),
      ).toBe(true);
    });

    it('rejects enabled metrics with empty RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: '',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects enabled metrics with whitespace-only RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: '   ',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('accepts enabled metrics with valid RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN:
          'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    // Exact-length boundary: pattern-only without .length(64) may admit 64hex + trailing newline.
    it('rejects 64hex followed by trailing newline (JavaScript $ can match before \\n)', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: 'a'.repeat(64) + '\n',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects 64hex followed by trailing carriage-return newline (\\r\\n)', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: 'a'.repeat(64) + '\r\n',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects exactly 65 hex characters (one over)', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: 'a'.repeat(65),
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects exactly 63 hex characters (one short)', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: 'a'.repeat(63),
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    // WU15-1 redaction: metrics token must not appear in validation errors
    it('redacts RECEIPT_MEDIA_METRICS_TOKEN from validation error when malformed', () => {
      const TOKEN_SENTINEL =
        'wu15t1-token-redaction-test-sentinel-9a3f' + 'Z'.repeat(43);
      const env: Record<string, unknown> = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: TOKEN_SENTINEL,
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) =>
          d.path.includes('RECEIPT_MEDIA_METRICS_TOKEN'),
        ),
      ).toBe(true);
      const detailsText = error!.details.map((d) => d.message).join(' | ');
      const detailsJson = JSON.stringify(error!.details);
      const stringified = String(error);
      const original = (error as { _original?: unknown })._original;
      for (const surface of [detailsText, detailsJson, stringified]) {
        expect(surface).not.toContain(TOKEN_SENTINEL);
      }
      // _original is deleted by redactValidationError; undefined → "undefined"
      expect(String(original)).not.toContain(TOKEN_SENTINEL);
    });

    // Metrics flag is independently validated (not keyed on RECEIPT_MEDIA_ENABLED)
    it('accepts RECEIPT_MEDIA_METRICS_ENABLED=true without RECEIPT_MEDIA_ENABLED=true', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_METRICS_ENABLED: 'true',
        RECEIPT_MEDIA_METRICS_TOKEN:
          'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('rejects RECEIPT_MEDIA_METRICS_ENABLED=true without RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_METRICS_ENABLED: 'true',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) =>
          d.path.includes('RECEIPT_MEDIA_METRICS_TOKEN'),
        ),
      ).toBe(true);
    });

    // ─── WU1C2A: Numeric relational bounds (compact table-driven) ────────
    // Every numeric env var is mutated in isolation against enabledBase.
    // The relational case (download smaller than metadata) and lease/attach
    // boundary cases are tested via the same path-targeted it.each plus a
    // tiny message-targeted assertion for the cross-field rule.
    const invalidNumericCases: Array<[string, string, string]> = [
      // META_MEDIA_METADATA_TIMEOUT_MS: positive integer, < lease.
      ['meta=0', 'META_MEDIA_METADATA_TIMEOUT_MS', '0'],
      ['meta=-1', 'META_MEDIA_METADATA_TIMEOUT_MS', '-1'],
      ['meta=60000 (=lease)', 'META_MEDIA_METADATA_TIMEOUT_MS', '60000'],
      ['meta=abc', 'META_MEDIA_METADATA_TIMEOUT_MS', 'abc'],
      // META_MEDIA_DOWNLOAD_TIMEOUT_MS: positive integer, < lease.
      ['down=0', 'META_MEDIA_DOWNLOAD_TIMEOUT_MS', '0'],
      ['down=60000 (=lease)', 'META_MEDIA_DOWNLOAD_TIMEOUT_MS', '60000'],
      // RECEIPT_MEDIA_WORKER_CONCURRENCY: integer 1..8.
      ['conc=0', 'RECEIPT_MEDIA_WORKER_CONCURRENCY', '0'],
      ['conc=9 (max+1)', 'RECEIPT_MEDIA_WORKER_CONCURRENCY', '9'],
      ['conc=1.5', 'RECEIPT_MEDIA_WORKER_CONCURRENCY', '1.5'],
      ['conc=abc', 'RECEIPT_MEDIA_WORKER_CONCURRENCY', 'abc'],
      // RECEIPT_MEDIA_WORKER_LEASE_MS: exactly 60000.
      ['lease=0', 'RECEIPT_MEDIA_WORKER_LEASE_MS', '0'],
      ['lease=59999', 'RECEIPT_MEDIA_WORKER_LEASE_MS', '59999'],
      ['lease=60001', 'RECEIPT_MEDIA_WORKER_LEASE_MS', '60001'],
      // RECEIPT_MEDIA_WORKER_POLL_MS: positive integer, < lease.
      ['poll=0', 'RECEIPT_MEDIA_WORKER_POLL_MS', '0'],
      ['poll=60000 (=lease)', 'RECEIPT_MEDIA_WORKER_POLL_MS', '60000'],
      // CHATBOT_API_ATTACH_TIMEOUT_MS: positive integer, <=30000, < lease.
      ['attach=0', 'CHATBOT_API_ATTACH_TIMEOUT_MS', '0'],
      ['attach=30001 (max+1)', 'CHATBOT_API_ATTACH_TIMEOUT_MS', '30001'],
      ['attach=60000 (=lease)', 'CHATBOT_API_ATTACH_TIMEOUT_MS', '60000'],
    ];
    it.each(invalidNumericCases)('rejects %s', (_label, field, value) => {
      const env = { ...enabledBase, [field]: value };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes(field))).toBe(true);
    });

    // Cross-field relation: metadata_timeout <= download_timeout. The
    // violation surfaces from the object-level custom check, so the
    // failure path targets the custom-key frame but the message names
    // both fields.
    it('rejects when META_MEDIA_DOWNLOAD_TIMEOUT_MS < META_MEDIA_METADATA_TIMEOUT_MS', () => {
      const env = {
        ...enabledBase,
        META_MEDIA_METADATA_TIMEOUT_MS: '5000',
        META_MEDIA_DOWNLOAD_TIMEOUT_MS: '1000',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      const allText = error!.details.map((d) => d.message).join(' | ');
      expect(allText).toMatch(/META_MEDIA_DOWNLOAD_TIMEOUT_MS/);
      expect(allText).toMatch(/META_MEDIA_METADATA_TIMEOUT_MS/);
    });

    // Valid boundary table: min, max, equality, and exact attach cap.
    const validNumericBoundaryCases: Array<[string, Record<string, string>]> = [
      [
        'min boundaries',
        {
          META_MEDIA_METADATA_TIMEOUT_MS: '1',
          META_MEDIA_DOWNLOAD_TIMEOUT_MS: '2',
          RECEIPT_MEDIA_WORKER_CONCURRENCY: '1',
          RECEIPT_MEDIA_WORKER_POLL_MS: '1',
          CHATBOT_API_ATTACH_TIMEOUT_MS: '1',
        },
      ],
      [
        'max boundaries',
        {
          META_MEDIA_METADATA_TIMEOUT_MS: '59999',
          META_MEDIA_DOWNLOAD_TIMEOUT_MS: '59999',
          RECEIPT_MEDIA_WORKER_CONCURRENCY: '8',
          RECEIPT_MEDIA_WORKER_POLL_MS: '59999',
          CHATBOT_API_ATTACH_TIMEOUT_MS: '30000',
        },
      ],
      [
        'metadata equals download',
        {
          META_MEDIA_METADATA_TIMEOUT_MS: '5000',
          META_MEDIA_DOWNLOAD_TIMEOUT_MS: '5000',
        },
      ],
    ];
    it.each(validNumericBoundaryCases)(
      'accepts numeric boundary: %s',
      (_label, overrides) => {
        const env = { ...enabledBase, ...overrides };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(error).toBeUndefined();
      },
    );

    // WU1C2B1: comma-separated version:base64 with unique positive versions; canonical base64 keys (RFC 4648 §4) >=32 bytes; active must be a member.
    const INVALID_KEYRING_32A = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=';
    const INVALID_KEYRING_32B = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';
    const KEYRING_TOO_SHORT_31 = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==';
    const KEY_WITH_INTERNAL_WS = `1:QUFB QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=`;
    const KEY_DUP_VERSIONS = `1:${INVALID_KEYRING_32A},1:${INVALID_KEYRING_32B}`;
    const hasFieldError = (err: unknown, field: string): boolean => {
      const d = (err as { details?: Array<{ path: Array<string | number> }> })
        ?.details;
      return !!d?.some((p) => p.path.includes(field));
    };

    const invalidKeyringCases: Array<[string, string]> = [
      ['only colon', ':'],
      ['missing colon', `1${INVALID_KEYRING_32A}`],
      ['empty version', `:${INVALID_KEYRING_32A}`],
      ['non-integer version', `abc:${INVALID_KEYRING_32A}`],
      ['zero version', `0:${INVALID_KEYRING_32A}`],
      ['negative version', `-1:${INVALID_KEYRING_32A}`],
      ['decimal version', `1.5:${INVALID_KEYRING_32A}`],
      ['leading zero version', `01:${INVALID_KEYRING_32A}`],
      ['empty base64', '1:'],
      ['non-base64 alphabet', `1:${'@'.repeat(44)}`],
      ['whitespace around entry', ` 1:${INVALID_KEYRING_32A}`],
      ['internal whitespace in key', KEY_WITH_INTERNAL_WS],
      ['length not multiple of 4', '1:QUFB'],
      ['31-byte key (too short)', `1:${KEYRING_TOO_SHORT_31}`],
      ['duplicate version', KEY_DUP_VERSIONS],
      ['trailing comma', `1:${INVALID_KEYRING_32A},`],
      ['leading comma', `,1:${INVALID_KEYRING_32A}`],
      ['double comma', `1:${INVALID_KEYRING_32A},,2:${INVALID_KEYRING_32B}`],
    ];
    it.each(invalidKeyringCases)(
      'rejects enabled with malformed RECEIPT_CAPABILITY_KEYS: %s',
      (_label, keys) => {
        const env = { ...enabledBase, RECEIPT_CAPABILITY_KEYS: keys };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(hasFieldError(error, 'RECEIPT_CAPABILITY_KEYS')).toBe(true);
      },
    );

    const invalidActiveVersionCases: Array<[string, string, string]> = [
      ['zero active version', '0', `1:${INVALID_KEYRING_32A}`],
      ['negative active version', '-1', `1:${INVALID_KEYRING_32A}`],
      ['non-integer active version', 'abc', `1:${INVALID_KEYRING_32A}`],
      ['non-member active version', '99', `1:${INVALID_KEYRING_32A}`],
    ];
    it.each(invalidActiveVersionCases)(
      'rejects enabled with %s',
      (_label, active, keys) => {
        const env = {
          ...enabledBase,
          RECEIPT_CAPABILITY_KEYS: keys,
          RECEIPT_CAPABILITY_ACTIVE_VERSION: active,
        };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(hasFieldError(error, 'RECEIPT_CAPABILITY_ACTIVE_VERSION')).toBe(
          true,
        );
      },
    );

    const KEY_V1_V2 = `1:${INVALID_KEYRING_32A},2:${INVALID_KEYRING_32B}`;
    const HUGE_KEYRING = `1:${INVALID_KEYRING_32A},9007199254740992:${INVALID_KEYRING_32B},9007199254740993:${INVALID_KEYRING_32A}`;
    const validKeyringCases: Array<[string, string, string]> = [
      ['single 32-byte key, active=v1', `1:${INVALID_KEYRING_32A}`, '1'],
      ['two 32-byte keys, active=v2', KEY_V1_V2, '2'],
      ['huge versions, active=lower', HUGE_KEYRING, '9007199254740992'],
      ['huge versions, active=higher', HUGE_KEYRING, '9007199254740993'],
    ];
    it.each(validKeyringCases)(
      'accepts enabled keyring: %s',
      (_label, keys, active) => {
        const env = {
          ...enabledBase,
          RECEIPT_CAPABILITY_KEYS: keys,
          RECEIPT_CAPABILITY_ACTIVE_VERSION: active,
        };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(error).toBeUndefined();
      },
    );

    // ─── Existing & multi-field regression ────────────────────────────
    it('preserves existing validEnv compatibility', () => {
      const { error } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
    it('does not interpolate the storage secret in validation errors', () => {
      const env = {
        ...enabledBase,
        RECEIPT_STORAGE_ENDPOINT: 'not-a-url',
        RECEIPT_STORAGE_SECRET_ACCESS_KEY: 'super-secret-sentinel',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      const allText = error!.details.map((d) => d.message).join(' | ');
      expect(allText).not.toContain('super-secret-sentinel');
    });

    // ─── WU1C2B2: validation error redaction ───────────────────────────
    // Two distinct sentinels are placed in credential-bearing and keyring-
    // bearing fields and intentionally force a Joi failure on the same
    // surface (URI for the endpoint, custom keyring parse). Every
    // observable error projection — top-level message, detail/context
    // serialization, and String(error) — MUST scrub both values before
    // the error leaves the validation wrapper.
    const STORAGE_CREDENTIAL_SENTINEL =
      'wu1c2b2-storage-credential-sentinel-9af3';
    const KEYRING_SENTINEL = 'wu1c2b2-keyring-sentinel-DEF456==';
    const assertValidationErrorRedacted = (
      error: Joi.ValidationError,
    ): void => {
      const detailsJson = JSON.stringify(error.details);
      const stringified = String(error);
      for (const sentinel of [STORAGE_CREDENTIAL_SENTINEL, KEYRING_SENTINEL]) {
        expect(error.message).not.toContain(sentinel);
        expect(detailsJson).not.toContain(sentinel);
        expect(stringified).not.toContain(sentinel);
      }
    };

    // Credential-only invalid: malformed URI carries the sentinel as its
    // `context.value` (and the value sits inside `_original`). The
    // keyring fields stay valid so the only failure path is the URI rule.
    it('redacts credential value from invalid RECEIPT_STORAGE_ENDPOINT', () => {
      const env = {
        ...enabledBase,
        RECEIPT_STORAGE_ENDPOINT: STORAGE_CREDENTIAL_SENTINEL,
        RECEIPT_STORAGE_ACCESS_KEY_ID: STORAGE_CREDENTIAL_SENTINEL,
        RECEIPT_STORAGE_SECRET_ACCESS_KEY: STORAGE_CREDENTIAL_SENTINEL,
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      assertValidationErrorRedacted(error!);
      // Field category is preserved for diagnostics.
      expect(
        error!.details.some((d) => d.path.includes('RECEIPT_STORAGE_ENDPOINT')),
      ).toBe(true);
    });

    // Keyring-only invalid: forcing the keyring to be malformed surfaces
    // the raw keyring sentinel through the custom throw and `_original`.
    // The redaction must scrub both surfaces.
    it('redacts keyring value from invalid RECEIPT_CAPABILITY_KEYS', () => {
      const env = {
        ...enabledBase,
        RECEIPT_CAPABILITY_KEYS: KEYRING_SENTINEL,
        RECEIPT_CAPABILITY_ACTIVE_VERSION: KEYRING_SENTINEL,
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      assertValidationErrorRedacted(error!);
    });

    // Both invalid simultaneously: multi-error aggregation must scrub
    // every detail independently — a single shared scrubber pass that
    // only inspects the first detail would miss this case.
    it('redacts both sentinels when credential and keyring fail together', () => {
      const env = {
        ...enabledBase,
        RECEIPT_STORAGE_ENDPOINT: STORAGE_CREDENTIAL_SENTINEL,
        RECEIPT_STORAGE_SECRET_ACCESS_KEY: STORAGE_CREDENTIAL_SENTINEL,
        RECEIPT_CAPABILITY_KEYS: KEYRING_SENTINEL,
        RECEIPT_CAPABILITY_ACTIVE_VERSION: KEYRING_SENTINEL,
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      // Multi-error aggregation: at least one detail per failing field.
      expect(
        error!.details.some((d) => d.path.includes('RECEIPT_STORAGE_ENDPOINT')),
      ).toBe(true);
      expect(
        error!.details.some((d) => d.path.includes('RECEIPT_CAPABILITY_KEYS')),
      ).toBe(true);
      assertValidationErrorRedacted(error!);
    });

    // Active-version-only invalid: the keyring parses fine but the
    // active version is not a member, exercising a different throw site
    // inside the same custom helper. The sentinel must still be scrubbed.
    it('redacts sentinel passed as RECEIPT_CAPABILITY_ACTIVE_VERSION', () => {
      const env = {
        ...enabledBase,
        RECEIPT_CAPABILITY_KEYS: `1:${INVALID_KEYRING_32A}`,
        RECEIPT_CAPABILITY_ACTIVE_VERSION: KEYRING_SENTINEL,
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      assertValidationErrorRedacted(error!);
    });
  });
});
