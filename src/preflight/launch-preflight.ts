/** MVP-3 offline, no-secret launch preflight: reads env NAMES/presence, a
 * posture allow-list, and migration NAMES only; never reads or prints values. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;
export type PresenceStatus = 'present' | 'missing';
export type PostureStatus = 'safe' | 'unsafe' | 'missing';
export type MigrationStatus = 'present_on_disk' | 'missing_on_disk';
export type ManualStatus = 'manual_external';
export type PostureValue = 'true' | 'false';

export type CoreConfigCheck = { name: string; status: PresenceStatus };
export type PostureCheck = {
  name: string;
  expected: PostureValue;
  status: PostureStatus;
};
export type MigrationCheck = { name: string; status: MigrationStatus };
export type ClientRouteCheck = {
  method: string;
  path: string;
  scope: string;
  status: ManualStatus;
};
export type ManualCheck = {
  id: string;
  description: string;
  status: ManualStatus;
};
export type PreflightFailure = {
  area: 'core_config' | 'posture' | 'migration';
  name: string;
  status: PresenceStatus | PostureStatus | MigrationStatus;
};
export type LaunchPreflightReport = {
  schemaVersion: 1;
  ok: boolean;
  coreConfig: CoreConfigCheck[];
  posture: PostureCheck[];
  migrations: MigrationCheck[];
  clientRoutes: ClientRouteCheck[];
  manualChecks: ManualCheck[];
  failures: PreflightFailure[];
};

export const CORE_CONFIG_NAMES = [
  'META_VERIFY_TOKEN',
  'META_APP_SECRET',
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
  'CHATBOT_API_BASE_URL',
  'SERVICE_KEY',
  'CHATBOT_API_BRANCH_ID',
  'CHATBOT_API_CASHIER_USER_ID',
  'OPENAI_API_KEY',
  'LLM_MODEL',
  'DATABASE_URL',
  'OPS_CHANNEL_PHONE',
] as const;

export const POSTURE_EXPECTATIONS: readonly {
  name: string;
  expected: PostureValue;
}[] = [
  { name: 'META_SANDBOX_RECIPIENT_NORMALIZATION', expected: 'false' },
  { name: 'HUMAN_HANDOFF_ENABLED', expected: 'true' },
  { name: 'RECEIPT_MEDIA_ENABLED', expected: 'false' },
  { name: 'RECEIPT_MEDIA_INGESTION_ENABLED', expected: 'false' },
  { name: 'RECEIPT_MEDIA_METRICS_ENABLED', expected: 'false' },
];

export const REQUIRED_MIGRATIONS = [
  '1700000000000_create-conversation-state.js',
  '1800000000000_create-processed-webhook-messages.js',
  '1900000000000_human_handoff_requests.js',
  '2000000000000_receipt_media.js',
  '2100000000000_receipt_media_cancellation_commands.js',
  '2200000000000_receipt_media_capability_string_versions.js',
] as const;

export const CLIENT_ROUTES: readonly (readonly [string, string, string])[] = [
  ['GET', '/chatbot-api/catalog/search', 'catalog:read'],
  ['GET', '/chatbot-api/catalog/:productId/stock', 'catalog:read'],
  ['POST', '/chatbot-api/pricing/evaluate-cart', 'pricing:evaluate'],
  ['GET', '/chatbot-api/customers/by-phone', 'customers:read'],
  ['PUT', '/chatbot-api/customers/by-phone', 'customers:write'],
  ['POST', '/chatbot-api/sales', 'sales:create'],
  ['GET', '/chatbot-api/payment-details', 'payment-details:read'],
  ['POST', '/chatbot-api/sales/:saleId/cancel', 'sales:write'],
  ['POST', '/chatbot-api/sales/:saleId/receipts', 'sales:write'],
  ['PATCH', '/chatbot-api/sales/:saleId/delivery', 'sales:write'],
  ['GET', '/chatbot-api/customers/by-phone/:phone/orders', 'customers:read'],
];

const MANUAL_PREREQUISITES: readonly (readonly [string, string])[] = [
  ['backend_reachable', 'Backend reachable from the chatbot host (manual).'],
  ['bot_cashier_user', 'Bot cashier User matches CHATBOT_API_CASHIER_USER_ID.'],
  ['service_credential', 'Seven scopes including payment-details:read.'],
  ['active_payment_detail', 'An active PaymentDetail exists (no 404).'],
  ['populated_catalog', 'Catalog has products for search/stock/cart flows.'],
];

const presenceOf = (env: EnvRecord, name: string): PresenceStatus =>
  env[name] === undefined || env[name] === '' ? 'missing' : 'present';

const evaluateCoreConfig = (env: EnvRecord): CoreConfigCheck[] =>
  CORE_CONFIG_NAMES.map((name) => ({ name, status: presenceOf(env, name) }));

const postureStatus = (
  raw: string | undefined,
  expected: PostureValue,
): PostureStatus => {
  if (raw === undefined || raw === '') return 'missing';
  return raw === expected ? 'safe' : 'unsafe';
};

const evaluatePosture = (env: EnvRecord): PostureCheck[] =>
  POSTURE_EXPECTATIONS.map(({ name, expected }) => ({
    name,
    expected,
    status: postureStatus(env[name], expected),
  }));

const evaluateMigrations = (filenames: readonly string[]): MigrationCheck[] => {
  const present = new Set(filenames);
  return REQUIRED_MIGRATIONS.map((name) => ({
    name,
    status: present.has(name) ? 'present_on_disk' : 'missing_on_disk',
  }));
};

export function runLaunchPreflight(input: {
  env: EnvRecord;
  migrationFilenames: readonly string[];
}): LaunchPreflightReport {
  const coreConfig = evaluateCoreConfig(input.env);
  const posture = evaluatePosture(input.env);
  const migrations = evaluateMigrations(input.migrationFilenames);
  const failures: PreflightFailure[] = [
    ...coreConfig.flatMap((c) =>
      c.status === 'missing'
        ? [{ area: 'core_config' as const, name: c.name, status: c.status }]
        : [],
    ),
    ...posture.flatMap((c) =>
      c.status !== 'safe'
        ? [{ area: 'posture' as const, name: c.name, status: c.status }]
        : [],
    ),
    ...migrations.flatMap((c) =>
      c.status === 'missing_on_disk'
        ? [{ area: 'migration' as const, name: c.name, status: c.status }]
        : [],
    ),
  ];
  return {
    schemaVersion: 1,
    ok: failures.length === 0,
    coreConfig,
    posture,
    migrations,
    clientRoutes: CLIENT_ROUTES.map(([method, path, scope]) => ({
      method,
      path,
      scope,
      status: 'manual_external',
    })),
    manualChecks: MANUAL_PREREQUISITES.map(([id, description]) => ({
      id,
      description,
      status: 'manual_external',
    })),
    failures,
  };
}
