import { envValidationSchema } from './env.validation';

/**
 * Unit tests for the Joi env validation schema.
 * These exercise the schema directly — no NestJS wiring needed.
 *
 * Tasks: 1.2, 1.3, 1.4
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
  };

  // ─── Task 1.2 ─────────────────────────────────────────────────────────────
  describe('META_VERIFY_TOKEN', () => {
    it('rejects when META_VERIFY_TOKEN is absent', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_VERIFY_TOKEN;

      const { error } = envValidationSchema.validate(env, { abortEarly: false });

      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('META_VERIFY_TOKEN'))).toBe(true);
    });

    it('accepts when META_VERIFY_TOKEN is a non-empty string', () => {
      const { error } = envValidationSchema.validate(validEnv, { abortEarly: false });
      expect(error).toBeUndefined();
    });
  });

  // ─── Task 1.3 ─────────────────────────────────────────────────────────────
  describe('CHATBOT_API_BASE_URL', () => {
    it('rejects when CHATBOT_API_BASE_URL is not a valid URL', () => {
      const env = { ...validEnv, CHATBOT_API_BASE_URL: 'not-a-url' };

      const { error } = envValidationSchema.validate(env, { abortEarly: false });

      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('CHATBOT_API_BASE_URL'))).toBe(true);
    });

    it('accepts when CHATBOT_API_BASE_URL is a valid HTTPS URL', () => {
      const env = { ...validEnv, CHATBOT_API_BASE_URL: 'https://backend.houndfe.com' };
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeUndefined();
    });
  });

  // ─── Task 1.4 ─────────────────────────────────────────────────────────────
  describe('SERVICE_KEY', () => {
    it('rejects when SERVICE_KEY does not start with svc_', () => {
      const env = { ...validEnv, SERVICE_KEY: 'invalid_key_without_prefix' };

      const { error } = envValidationSchema.validate(env, { abortEarly: false });

      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('SERVICE_KEY'))).toBe(true);
    });

    it('accepts when SERVICE_KEY starts with svc_', () => {
      const env = { ...validEnv, SERVICE_KEY: 'svc_abc123' };
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeUndefined();
    });
  });

  // ─── Additional required vars ────────────────────────────────────────────
  describe('other required vars', () => {
    it('rejects when META_APP_SECRET is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_APP_SECRET;
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('META_APP_SECRET'))).toBe(true);
    });

    it('rejects when META_ACCESS_TOKEN is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_ACCESS_TOKEN;
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('META_ACCESS_TOKEN'))).toBe(true);
    });

    it('rejects when META_PHONE_NUMBER_ID is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).META_PHONE_NUMBER_ID;
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('META_PHONE_NUMBER_ID'))).toBe(true);
    });

    it('rejects when CHATBOT_API_BRANCH_ID is missing', () => {
      const env = { ...validEnv };
      delete (env as Partial<typeof validEnv>).CHATBOT_API_BRANCH_ID;
      const { error } = envValidationSchema.validate(env, { abortEarly: false });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('CHATBOT_API_BRANCH_ID'))).toBe(true);
    });

    it('allows PORT to be absent (defaults to 3000)', () => {
      const { error, value } = envValidationSchema.validate(validEnv, { abortEarly: false });
      expect(error).toBeUndefined();
      expect(value.PORT).toBe(3000);
    });
  });
});
