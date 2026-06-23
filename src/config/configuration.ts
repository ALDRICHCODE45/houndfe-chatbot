/**
 * Typed configuration factory loaded by ConfigModule.
 *
 * All values come from environment variables already validated by
 * envValidationSchema (Joi). By the time this factory runs, every
 * required var is guaranteed to be present and correctly formatted.
 */
const configuration = () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),

  meta: {
    /** Token used to verify the GET webhook challenge from Meta */
    verifyToken: process.env.META_VERIFY_TOKEN as string,
    /** App secret used for HMAC-SHA256 signature verification */
    appSecret: process.env.META_APP_SECRET as string,
    /** Bearer token for outbound calls to Meta Graph API */
    accessToken: process.env.META_ACCESS_TOKEN as string,
  },

  chatbotApi: {
    /** Base URL of the houndfe-backend /chatbot-api/* endpoints */
    baseUrl: process.env.CHATBOT_API_BASE_URL as string,
    /** Raw service credential key (starts with "svc_") */
    serviceKey: process.env.SERVICE_KEY as string,
    /** Branch ID sent as X-Branch-Id on every chatbot-api request */
    branchId: process.env.CHATBOT_API_BRANCH_ID as string,
  },
});

export default configuration;

/** Inferred return type — use for typed `ConfigService.get<AppConfig['meta']>()` calls */
export type AppConfig = ReturnType<typeof configuration>;
