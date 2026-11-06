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

    it('ignores the removed minimal-route enable, allowlist and order vars', () => {
      const env = {
        ...validEnv,
        MINIMAL_CATALOG_AGENT_ENABLED: 'not-a-boolean',
        MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS: 'owner@example.com',
        MINIMAL_CATALOG_ORDER_ENABLED: 'nope',
      };
      const { error, value } = envValidationSchema.validate(env, {
        abortEarly: false,
      }) as { error?: undefined; value: Record<string, unknown> };
      expect(error).toBeUndefined();
      expect(value).toEqual(
        expect.objectContaining({
          MINIMAL_CATALOG_AGENT_ENABLED: 'not-a-boolean',
          MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS: 'owner@example.com',
          MINIMAL_CATALOG_ORDER_ENABLED: 'nope',
        }),
      );
      const { value: baseline } = envValidationSchema.validate(validEnv) as {
        value: Record<string, unknown>;
      };
      expect(baseline).not.toHaveProperty('MINIMAL_CATALOG_AGENT_ENABLED');
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

    it.each(['1', '3', '4', '6'])(
      'preserves an explicit LLM_MAX_STEPS=%s',
      (steps) => {
        const { error, value } = envValidationSchema.validate({
          ...validEnv,
          LLM_MAX_STEPS: steps,
        }) as { error?: unknown; value: Record<string, unknown> };
        expect(error).toBeUndefined();
        expect(value.LLM_MAX_STEPS).toBe(Number(steps));
      },
    );

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
      expect(value.LLM_MAX_STEPS).toBe(4);
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
  describe('OPS_CHANNEL_PHONE (always required)', () => {
    it('rejects when OPS_CHANNEL_PHONE is missing', () => {
      const env: Record<string, string> = { ...validEnv };
      delete env.OPS_CHANNEL_PHONE;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.message.includes('OPS_CHANNEL_PHONE')),
      ).toBe(true);
    });

    it('rejects when OPS_CHANNEL_PHONE is an empty string', () => {
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

    // MVP-5 ops-sender mismatch: production compares the stored value
    // verbatim against the digit-only inbound `wa_id`. A leading `+`,
    // whitespace, separator, or any non-digit form must fail at boot
    // instead of silently breaking ops handoff reply routing.
    it.each([
      '+5219999888777',
      ' 5219999888777',
      '521 9998887777',
      '521-9998-88777',
    ])('rejects non digit-only OPS_CHANNEL_PHONE=%s', (value) => {
      const env = { ...validEnv, OPS_CHANNEL_PHONE: value };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('OPS_CHANNEL_PHONE')),
      ).toBe(true);
    });

    it.each(['123456789', '1234567890123456'])(
      'rejects OPS_CHANNEL_PHONE outside the 10-15 digit length=%s',
      (value) => {
        const env = { ...validEnv, OPS_CHANNEL_PHONE: value };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(error).toBeDefined();
        expect(
          error!.details.some((d) => d.path.includes('OPS_CHANNEL_PHONE')),
        ).toBe(true);
      },
    );

    it.each(['1234567890', '123456789012345'])(
      'accepts digit-only OPS_CHANNEL_PHONE value=%s',
      (value) => {
        const env = { ...validEnv, OPS_CHANNEL_PHONE: value };
        const { error } = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        expect(error).toBeUndefined();
      },
    );

    it('accepts a valid OPS_CHANNEL_PHONE', () => {
      const env = { ...validEnv, OPS_CHANNEL_PHONE: '5219999888777' };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('still requires OPS_CHANNEL_PHONE when the removed HUMAN_HANDOFF_ENABLED=false is set', () => {
      const env: Record<string, string> = {
        ...validEnv,
        HUMAN_HANDOFF_ENABLED: 'false',
      };
      delete env.OPS_CHANNEL_PHONE;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('OPS_CHANNEL_PHONE')),
      ).toBe(true);
    });
  });

  describe('META_SANDBOX_RECIPIENT_NORMALIZATION', () => {
    it.each([
      [undefined, false, false],
      ['true', true, false],
      ['yes', undefined, true],
    ])('validates flag=%s', (flag, expected, invalid) => {
      const { error, value } = envValidationSchema.validate(
        flag === undefined
          ? { ...validEnv }
          : { ...validEnv, META_SANDBOX_RECIPIENT_NORMALIZATION: flag },
        { abortEarly: false },
      ) as { error?: Joi.ValidationError; value: Record<string, unknown> };
      expect(Boolean(error)).toBe(invalid);
      if (invalid) {
        expect(error!.details[0].path).toContain(
          'META_SANDBOX_RECIPIENT_NORMALIZATION',
        );
      } else {
        expect(value.META_SANDBOX_RECIPIENT_NORMALIZATION).toBe(expected);
      }
    });
  });

  // ─── WU1C1 + WU1C2A: Receipt media conditional validation foundation ───
  // Disabled (default) MUST be permissive; enabled MUST strictly validate
  // the listed receipt-media fields. WU1C2A extends enabledBase once with
  // numeric timeout/concurrency/lease/poll/attach values and proves the
  // relational bounds at the same compactness budget.
  describe('RECEIPT_MEDIA_* (always on, receipt payment flow R3)', () => {
    const enabledBase = {
      ...validEnv,
      RECEIPT_MEDIA_MAX_BYTES: '10485760',
      META_MEDIA_ALLOWED_HOSTS: 'graph.facebook.com,.meta.com',
      // WU15-1: dedicated metrics Bearer token — 64 hex chars from 32 random bytes.
      RECEIPT_MEDIA_METRICS_TOKEN:
        'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      // WU1C2A numeric relations: metadata=5s, download=30s,
      // concurrency=2, lease=exactly 60s, poll=1s.
      META_MEDIA_METADATA_TIMEOUT_MS: '5000',
      META_MEDIA_DOWNLOAD_TIMEOUT_MS: '30000',
      RECEIPT_MEDIA_WORKER_CONCURRENCY: '2',
      RECEIPT_MEDIA_WORKER_LEASE_MS: '60000',
      RECEIPT_MEDIA_WORKER_POLL_MS: '1000',
    };

    it('derives every receipt knob from defaults when none is set', () => {
      const { error, value } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      }) as { error?: undefined; value: Record<string, unknown> };
      expect(error).toBeUndefined();
      expect(value).toMatchObject({
        RECEIPT_MEDIA_MAX_BYTES: 10485760,
        META_MEDIA_ALLOWED_HOSTS: 'lookaside.fbsbx.com',
        META_MEDIA_METADATA_TIMEOUT_MS: 10000,
        META_MEDIA_DOWNLOAD_TIMEOUT_MS: 30000,
        RECEIPT_MEDIA_WORKER_CONCURRENCY: 2,
        RECEIPT_MEDIA_WORKER_LEASE_MS: 60000,
        RECEIPT_MEDIA_WORKER_POLL_MS: 5000,
      });
    });

    // R3/S4: removed storage, capability and flag vars are not validated, so
    // any value (even a malformed one) has no effect.
    const REMOVED_RECEIPT_VARS = [
      'RECEIPT_MEDIA_ENABLED',
      'RECEIPT_MEDIA_INGESTION_ENABLED',
      'RECEIPT_STORAGE_ENDPOINT',
      'RECEIPT_STORAGE_REGION',
      'RECEIPT_STORAGE_BUCKET',
      'RECEIPT_STORAGE_ACCESS_KEY_ID',
      'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
      'RECEIPT_STORAGE_FORCE_PATH_STYLE',
      'RECEIPT_MEDIA_PUBLIC_BASE_URL',
      'RECEIPT_CAPABILITY_KEYS',
      'RECEIPT_CAPABILITY_ACTIVE_VERSION',
      'CHATBOT_API_ATTACH_TIMEOUT_MS',
    ];
    it.each(['true', 'false', 'not-a-url', ''])(
      'boots unchanged with the removed receipt vars set to %j',
      (value) => {
        const env: Record<string, unknown> = { ...validEnv };
        for (const key of REMOVED_RECEIPT_VARS) env[key] = value;
        const removed = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        const plain = envValidationSchema.validate(validEnv, {
          abortEarly: false,
        });
        expect(removed.error).toBeUndefined();
        const validated = removed.value as Record<string, unknown>;
        for (const key of Object.keys(plain.value as object))
          expect(validated[key]).toEqual(
            (plain.value as Record<string, unknown>)[key],
          );
      },
    );

    // ─── Valid enabled fixture ─────────────────────────────────────────
    it('accepts a complete valid environment', () => {
      const { error } = envValidationSchema.validate(enabledBase, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
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

    // ─── WU15-1: Optional dedicated metrics token validation ──────────────
    // RECEIPT_MEDIA_METRICS_TOKEN is optional; the metrics endpoint is served
    // exactly when it is configured. Any supplied token must be valid 64hex.
    it('rejects supplied invalid token (too short)', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_METRICS_TOKEN: 'too-short',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects supplied invalid token (non-hex chars)', () => {
      const env = {
        ...validEnv,
        RECEIPT_MEDIA_METRICS_TOKEN:
          'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('accepts absent RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = { ...enabledBase };
      delete (env as Record<string, unknown>).RECEIPT_MEDIA_METRICS_TOKEN;
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });

    it('accepts a valid token without any other receipt var', () => {
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

    it('rejects empty RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: '',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('rejects whitespace-only RECEIPT_MEDIA_METRICS_TOKEN', () => {
      const env = {
        ...enabledBase,
        RECEIPT_MEDIA_METRICS_TOKEN: '   ',
      };
      const { error } = envValidationSchema.validate(env, {
        abortEarly: false,
      });
      expect(error).toBeDefined();
    });

    it('accepts valid RECEIPT_MEDIA_METRICS_TOKEN', () => {
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

    // T4: the removed RECEIPT_MEDIA_METRICS_ENABLED flag has no effect; an
    // unknown key is tolerated and never makes the token required.
    it.each(['true', 'false', 'not-a-boolean'])(
      'ignores removed RECEIPT_MEDIA_METRICS_ENABLED=%s',
      (value) => {
        const env = { ...validEnv, RECEIPT_MEDIA_METRICS_ENABLED: value };
        const result = envValidationSchema.validate(env, {
          abortEarly: false,
        });
        const validated = result.value as Record<string, unknown>;
        expect(result.error).toBeUndefined();
        expect(validated.RECEIPT_MEDIA_METRICS_TOKEN).toBeUndefined();
      },
    );

    // ─── WU1C2A: Numeric relational bounds (compact table-driven) ────────
    // Every numeric env var is mutated in isolation against enabledBase.
    // The relational case (download smaller than metadata) and lease
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

    // Valid boundary table: min, max and equality.
    const validNumericBoundaryCases: Array<[string, Record<string, string>]> = [
      [
        'min boundaries',
        {
          META_MEDIA_METADATA_TIMEOUT_MS: '1',
          META_MEDIA_DOWNLOAD_TIMEOUT_MS: '2',
          RECEIPT_MEDIA_WORKER_CONCURRENCY: '1',
          RECEIPT_MEDIA_WORKER_POLL_MS: '1',
        },
      ],
      [
        'max boundaries',
        {
          META_MEDIA_METADATA_TIMEOUT_MS: '59999',
          META_MEDIA_DOWNLOAD_TIMEOUT_MS: '59999',
          RECEIPT_MEDIA_WORKER_CONCURRENCY: '8',
          RECEIPT_MEDIA_WORKER_POLL_MS: '59999',
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

    // ─── Existing & multi-field regression ────────────────────────────
    it('preserves existing validEnv compatibility', () => {
      const { error } = envValidationSchema.validate(validEnv, {
        abortEarly: false,
      });
      expect(error).toBeUndefined();
    });
  });

  // U6: the backend quotes carriers; the removed chatbot-side shipping vars
  // are no longer validated, so any value (even a malformed one) has no effect.
  describe('removed shipping vars', () => {
    it.each(['true', 'false', 'TRUE', 'nope'])(
      'boots unchanged with the removed shipping vars set (flags=%s)',
      (flag) => {
        const env = {
          ...validEnv,
          SHIPPING_QUOTES_ENABLED: flag,
          MINIMAL_CATALOG_SHIPPING_ENABLED: flag,
          SHIPPING_DEMO_PARCEL_PROFILE_JSON: '{not json',
          SKYDROPX_BASE_URL: 'not-a-url',
          SKYDROPX_CLIENT_ID: '',
          SKYDROPX_CLIENT_SECRET: '',
          SKYDROPX_ORIGIN_POSTAL_CODE: 'abc',
          SKYDROPX_ORIGIN_STATE: 'x'.repeat(101),
          SKYDROPX_ORIGIN_MUNICIPALITY: '',
          SKYDROPX_ORIGIN_NEIGHBORHOOD: '',
        };
        const { error, value } = envValidationSchema.validate(env, {
          abortEarly: false,
        }) as { error?: undefined; value: Record<string, unknown> };
        expect(error).toBeUndefined();
        // Passed through untouched (allowUnknown), never coerced or defaulted.
        expect(value.SHIPPING_QUOTES_ENABLED).toBe(flag);
        expect(value.SKYDROPX_BASE_URL).toBe('not-a-url');
      },
    );

    it('adds no shipping defaults when the removed vars are absent', () => {
      const { value } = envValidationSchema.validate(validEnv) as {
        value: Record<string, unknown>;
      };
      expect(
        Object.keys(value).filter((key) =>
          /^(SHIPPING_|SKYDROPX_|MINIMAL_CATALOG_SHIPPING)/.test(key),
        ),
      ).toEqual([]);
    });
  });
});
