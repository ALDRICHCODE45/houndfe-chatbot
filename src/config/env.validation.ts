import * as Joi from 'joi';

/**
 * Joi validation schema for all required environment variables.
 *
 * Validation options (applied by ConfigModule):
 *   abortEarly: false  — collect ALL errors before throwing, not just the first
 *   allowUnknown: true — Node.js process.env contains OS and platform vars; ignore them
 *
 * Required vars:
 *   META_VERIFY_TOKEN      — webhook challenge token (shared with Meta dashboard)
 *   META_APP_SECRET        — HMAC-SHA256 secret for signature verification
 *   META_ACCESS_TOKEN      — Graph API access token for sending messages
 *   CHATBOT_API_BASE_URL   — base URL of the houndfe-backend chatbot-api
 *   SERVICE_KEY            — ServiceCredential raw key; MUST start with "svc_"
 *   CHATBOT_API_BRANCH_ID  — tenant branch id sent as X-Branch-Id header
 *
 * Optional vars:
 *   PORT  — HTTP listening port, defaults to 3000
 */
export const envValidationSchema = Joi.object({
  META_VERIFY_TOKEN: Joi.string().required(),
  META_APP_SECRET: Joi.string().required(),
  META_ACCESS_TOKEN: Joi.string().required(),
  CHATBOT_API_BASE_URL: Joi.string().uri().required(),
  SERVICE_KEY: Joi.string()
    .pattern(/^svc_/)
    .required()
    .messages({
      'string.pattern.base': '"SERVICE_KEY" must start with "svc_"',
    }),
  CHATBOT_API_BRANCH_ID: Joi.string().required(),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
}).options({ allowUnknown: true });
