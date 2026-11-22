/** Live rehearsal of the restock backorder («pedido por reposición») against
 * the DEV backend (docs/minimal-backorder.md, "Dev rehearsal"). It drives the
 * CHATBOT's own clients (`ChatbotApiHttpClient`: RESTOCK intake + poll, feed,
 * ACK, checkout; `BackorderHttpClient`) and a staff session only for what the
 * team does (answer the RESTOCK, raise the stock, cancel the sale).
 *
 * WRITES DEV DATA (a RESTOCK decision, a test customer, a backorder, a pickup
 * sale, two stock adjustments) and cleans up in a `finally`, listing what it
 * could not. Refuses any base URL other than localhost:3003. Never prints the
 * service key, the staff token or password, request headers or phone numbers:
 * only step outcomes, HTTP statuses, error codes and ids. */
import { randomUUID } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import { ChatbotApiError } from '../../src/chatbot-api/domain/errors';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import { backorderCheckoutFailure } from '../../src/chatbot-api/domain/dtos/checkout.dto';
import {
  isBackorderItem,
  type BackorderFeedItem,
  type FeedItem,
} from '../../src/chatbot-api/domain/dtos/human-requests.dto';
import {
  BACKORDER_ERROR,
  backorderIdempotencyKey,
  type BackorderBot,
} from '../../src/backorders/domain/backorder';
import { BackorderHttpClient } from '../../src/backorders/infrastructure/backorder-http.client';

const REQUIRED_ENV = ['CHATBOT_API_BASE_URL', 'SERVICE_KEY'] as const;

/** Dev fixtures from the backend agent's recipe. */
const PRODUCT_ID = '1f505ecd-5a31-4b4c-a28b-8955e93459b4';
const DEFAULT_CASHIER_USER_ID = '1f1d646b-f1f1-4303-9f43-8d842ed18de8';
const DEFAULT_BRANCH_ID = 'ced6cc10-a037-4f41-92af-ee69bbb51c8b';
/** Documented dev demo staff account (only ever used against localhost:3003). */
const DEFAULT_STAFF_EMAIL = 'manager@houndfe.com';
const DEFAULT_STAFF_PASSWORD = 'Manager123!';
/** The test customer of `human-requests-feed-e2e.ts` (`--phone` default). */
const TEST_PHONE_COUNTRY_CODE = '52';
const TEST_PHONE = '5550001111';
const TEST_FIRST_NAME = 'E2E Backorder';
const QUANTITY = 2;
const RESTOCK_DAYS = 7;

const FEED_PAGE_LIMIT = 50;
const OBSERVE_ANSWERED_MS = 15_000;
const WAIT_RESERVED_MS = 30_000;

class StepFailure extends Error {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function line(step: string, outcome: string, fields: Record<string, unknown>) {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  process.stdout.write(
    `[${step}] ${outcome}${rendered ? ` ${rendered}` : ''}\n`,
  );
}

const maskPhone = (phone: string) => `***${phone.slice(-2)}`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type KeyTree = string | KeyTree[] | { [key: string]: KeyTree };

/** Key tree of a body: names and JSON types only, never values. */
function keyTree(value: unknown, depth = 0): KeyTree {
  if (Array.isArray(value))
    return value.length === 0 ? '[]' : [keyTree(value[0], depth + 1)];
  if (typeof value === 'object' && value !== null) {
    if (depth > 3) return '{…}';
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, keyTree(v, depth + 1)]),
    );
  }
  return value === null ? 'null' : typeof value;
}

/** Status and stable error code of any failure; never headers or messages
 *  that could carry personal values. */
function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof ChatbotApiError)
    return {
      http: error.statusCode,
      code: error.errorCode,
      error: error.name,
    };
  if (error instanceof StepFailure) return { reason: error.message };
  return { error: error instanceof Error ? error.name : typeof error };
}

function errorCodeOf(body: unknown): string | null {
  const found = record(body)?.error ?? record(body)?.code;
  return typeof found === 'string' ? found : null;
}

interface StepResult {
  step: string;
  outcome: 'PASS' | 'WARN' | 'FAIL';
  http: string;
  code: string | null;
}
const results: StepResult[] = [];

function pass(
  step: string,
  http: number | string,
  fields: Record<string, unknown> = {},
  code: string | null = null,
  outcome: 'PASS' | 'WARN' = 'PASS',
) {
  results.push({ step, outcome, http: String(http), code });
  line(step, outcome, { http, ...(code ? { code } : {}), ...fields });
}

function failStep(
  step: string,
  reason: string,
  http: number | string | null = null,
  code: string | null = null,
  fields: Record<string, unknown> = {},
): never {
  results.push({ step, outcome: 'FAIL', http: String(http), code });
  line(step, 'FAIL', {
    ...(http === null ? {} : { http }),
    ...(code ? { code } : {}),
    reason,
    ...fields,
  });
  throw new StepFailure(step);
}

/** Wraps a bot client call: a ChatbotApiError becomes a FAIL with its status
 *  and code; anything else a FAIL with the error name only. */
async function bot<T>(step: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    const described = describeError(error);
    return failStep(
      step,
      'bot client call failed',
      typeof described.http === 'number' ? described.http : null,
      typeof described.code === 'string' ? described.code : null,
      typeof described.error === 'string' ? { error: described.error } : {},
    );
  }
}

/* ---- Staff session (axios that never throws on a status) ---- */

interface StaffResponse {
  status: number;
  data: unknown;
}

class StaffSession {
  private token: string | null = null;
  private readonly http: AxiosInstance;

  constructor(
    baseURL: string,
    private readonly email: string,
    private readonly password: string,
  ) {
    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      validateStatus: () => true,
    });
  }

  async login(): Promise<StaffResponse> {
    const response = await this.request('POST', '/auth/login', {
      data: { email: this.email, password: this.password },
      auth: false,
    });
    const token = record(response.data)?.accessToken;
    if (response.status >= 200 && response.status < 300) {
      if (typeof token !== 'string' || token === '')
        return { status: response.status, data: { error: 'NO_ACCESS_TOKEN' } };
      this.token = token;
    }
    return response;
  }

  async request(
    method: 'GET' | 'POST',
    url: string,
    options: {
      data?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ): Promise<StaffResponse> {
    try {
      const response = await this.http.request<unknown>({
        method,
        url,
        data: options.data,
        headers: {
          ...(options.data === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...(options.auth === false || this.token === null
            ? {}
            : { Authorization: `Bearer ${this.token}` }),
          ...(options.headers ?? {}),
        },
      });
      return { status: response.status, data: response.data };
    } catch (error) {
      // Never print raw errors: an Axios error carries the request headers.
      return {
        status: 0,
        data: { error: error instanceof Error ? error.name : 'REQUEST_FAILED' },
      };
    }
  }
}

const isOk = (response: StaffResponse) =>
  response.status >= 200 && response.status < 300;

/* ---- Feed observation ---- */

class FeedWatcher {
  private cursor: string | null = null;
  readonly seen: FeedItem[] = [];

  constructor(private readonly client: ChatbotApiHttpClient) {}

  /** Reads to the current end of the feed so only NEW items are examined. */
  async tail(): Promise<void> {
    for (;;) {
      const page = await this.client.readFeed({
        ...(this.cursor === null ? {} : { after: this.cursor }),
        limit: FEED_PAGE_LIMIT,
        waitSeconds: 0,
      });
      if (page.kind === 'RATE_LIMITED') {
        await sleep((page.retryAfterSeconds ?? 1) * 1000);
        continue;
      }
      if (page.kind === 'CURSOR_EXPIRED')
        throw new StepFailure('CURSOR_EXPIRED while reading the feed tail');
      if (page.nextCursor !== '') this.cursor = page.nextCursor;
      if (page.items.length === 0) return;
    }
  }

  /** The first item (already seen or arriving within `timeoutMs`) that
   *  satisfies `match`, or `null`. Reading does not ACK anything. */
  async find(
    match: (item: FeedItem) => boolean,
    timeoutMs: number,
  ): Promise<FeedItem | null> {
    const earlier = this.seen.find(match);
    if (earlier !== undefined) return earlier;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waitSeconds = Math.max(
        0,
        Math.min(3, Math.floor((deadline - Date.now()) / 1000)),
      );
      const page = await this.client.readFeed({
        ...(this.cursor === null ? {} : { after: this.cursor }),
        limit: FEED_PAGE_LIMIT,
        waitSeconds,
      });
      if (page.kind === 'RATE_LIMITED') {
        await sleep((page.retryAfterSeconds ?? 1) * 1000);
        continue;
      }
      if (page.kind === 'CURSOR_EXPIRED')
        throw new StepFailure('CURSOR_EXPIRED while polling the feed');
      if (page.nextCursor !== '') this.cursor = page.nextCursor;
      this.seen.push(...page.items);
      const hit = page.items.find(match);
      if (hit !== undefined) return hit;
      if (page.items.length === 0 && waitSeconds === 0) await sleep(500);
    }
    return null;
  }
}

/* ---- Rehearsal ---- */

interface State {
  decisionId: string | null;
  backorderId: string | null;
  saleId: string | null;
  saleCancelled: boolean;
  stockRaised: boolean;
  stockCorrected: boolean;
}

interface Context {
  bot: ChatbotApiHttpClient;
  backorders: BackorderHttpClient;
  staff: StaffSession;
  watcher: FeedWatcher;
  cashierUserId: string;
  runId: string;
  ack: boolean;
}

function untrackedVersion(body: unknown): number | null {
  const untracked = record(record(record(body)?.product)?.untracked);
  const version = untracked?.version;
  return typeof version === 'number' && Number.isInteger(version)
    ? version
    : null;
}

async function readStockVersion(ctx: Context, step: string): Promise<number> {
  const response = await ctx.staff.request(
    'GET',
    `/inventory/products/${PRODUCT_ID}/stock`,
  );
  if (!isOk(response))
    return failStep(
      step,
      'staff stock read failed',
      response.status,
      errorCodeOf(response.data),
    );
  const version = untrackedVersion(response.data);
  if (version === null)
    return failStep(
      step,
      'CONTRACT_MISMATCH: product.untracked.version',
      200,
      null,
      {
        bodyKeys: keyTree(response.data),
      },
    );
  return version;
}

async function adjustStock(
  ctx: Context,
  step: string,
  version: number,
  delta: number,
  reason: string,
  note: string,
  keySuffix: string,
): Promise<StaffResponse> {
  return ctx.staff.request('POST', '/inventory/adjustments', {
    headers: { 'Idempotency-Key': `e2e-backorder-${ctx.runId}-${keySuffix}` },
    data: {
      target: { productId: PRODUCT_ID },
      expectedVersion: version,
      delta,
      reason,
      note,
    },
  });
}

async function activeBackordersOfProduct(
  ctx: Context,
): Promise<BackorderBot[]> {
  const all = await ctx.backorders.listBackorders({
    status: 'WAITING,RESERVED',
  });
  return all.filter((backorder) => backorder.productId === PRODUCT_ID);
}

async function rehearse(ctx: Context, state: State): Promise<void> {
  // 0. Staff session.
  const login = await ctx.staff.login();
  if (!isOk(login))
    failStep(
      '0.staffLogin',
      'login refused',
      login.status,
      errorCodeOf(login.data),
    );
  pass('0.staffLogin', login.status);

  // 0b. Preconditions: stock 0, no other active backorder of the product.
  const stock = await bot('0.preflight', () => ctx.bot.getStock(PRODUCT_ID));
  if (stock.variants.length > 0 || stock.stock.quantity !== 0)
    failStep(
      '0.preflight',
      'product must have no variants and stock 0',
      200,
      null,
      {
        quantity: stock.stock.quantity,
        variants: stock.variants.length,
      },
    );
  const others = await bot('0.preflight', () => activeBackordersOfProduct(ctx));
  if (others.length > 0)
    failStep(
      '0.preflight',
      'another active backorder exists for the product; aborting without changes',
      200,
      null,
      { active: others.length },
    );
  pass('0.preflight', 200, {
    stock: 0,
    activeBackorders: 0,
    product: stock.name,
  });

  await bot('0.feedTail', () => ctx.watcher.tail());
  pass('0.feedTail', 200);

  // 1. The bot asks RESTOCK through its client (intake POST) and keeps the id.
  const sourceRequestId = randomUUID();
  const receipt = await bot('1.restockIntake', () =>
    ctx.bot.submitRestockIntake({
      sourceRequestId,
      type: 'RESTOCK',
      productId: PRODUCT_ID,
      productName: stock.name,
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: 0,
      stockObservedAt: new Date().toISOString(),
      supersedesDecisionId: null,
    }),
  );
  state.decisionId = receipt.id;
  pass('1.restockIntake', 201, {
    decisionId: receipt.id,
    status: receipt.status,
  });

  // 2. Team answers: version read, then PROVIDE_RESTOCK_ESTIMATE.
  const decision = await ctx.staff.request(
    'GET',
    `/human-decisions/${receipt.id}`,
  );
  const version = record(decision.data)?.version;
  if (!isOk(decision) || typeof version !== 'number')
    failStep(
      '2.staffReadDecision',
      'cannot read the decision version',
      decision.status,
      errorCodeOf(decision.data),
      {
        bodyKeys: keyTree(decision.data),
      },
    );
  pass('2.staffReadDecision', decision.status, { version });

  const resolve = await ctx.staff.request(
    'POST',
    `/human-decisions/${receipt.id}/resolve`,
    {
      data: {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: RESTOCK_DAYS,
        expectedVersion: version,
        resolutionRequestId: randomUUID(),
      },
    },
  );
  if (!isOk(resolve))
    failStep(
      '2.staffResolve',
      'resolve refused',
      resolve.status,
      errorCodeOf(resolve.data),
      {
        bodyKeys: keyTree(resolve.data),
      },
    );
  pass('2.staffResolve', resolve.status, { restockDays: RESTOCK_DAYS });

  // 2b. The bot's own poll sees the answer (what the estimate poller reads).
  const polled = await bot('2.botPollDecision', () =>
    ctx.bot.getRestockDecision(receipt.id),
  );
  if (
    polled.status !== 'RESOLVED' ||
    polled.resolution.action !== 'PROVIDE_RESTOCK_ESTIMATE' ||
    polled.resolution.restockDays !== RESTOCK_DAYS
  )
    failStep(
      '2.botPollDecision',
      'bot poll does not show the estimate',
      200,
      null,
      {
        status: polled.status,
      },
    );
  pass('2.botPollDecision', 200, {
    status: polled.status,
    restockDays: polled.resolution.restockDays,
  });

  // 2c. request.answered on the feed: observe only (never ACKed here).
  const answered = await bot('2.feedRequestAnswered', () =>
    ctx.watcher.find(
      (item) =>
        item.type === 'request.answered' &&
        (JSON.stringify(item).includes(receipt.id) ||
          JSON.stringify(item).includes(sourceRequestId)),
      OBSERVE_ANSWERED_MS,
    ),
  );
  if (answered === null)
    pass(
      '2.feedRequestAnswered',
      200,
      {
        observed: false,
        note: 'no request.answered for the decision within 15 s (informational)',
      },
      null,
      'WARN',
    );
  else
    pass('2.feedRequestAnswered', 200, {
      observed: true,
      deliveryId: answered.deliveryId,
      acked: false,
    });

  // 3. Bot schedules (BackorderHttpClient): expect WAITING.
  const senderId = `${TEST_PHONE_COUNTRY_CODE}1${TEST_PHONE}`;
  const scheduleInput = {
    phoneCountryCode: TEST_PHONE_COUNTRY_CODE,
    phone: TEST_PHONE,
    customer: { mode: 'createIfAbsent' as const, firstName: TEST_FIRST_NAME },
    productId: PRODUCT_ID,
    quantity: QUANTITY,
    sourceDecisionId: receipt.id,
  };
  const key = `${backorderIdempotencyKey(receipt.id, senderId)}:e2e-${ctx.runId}`;
  const created = await bot('3.createBackorder', () =>
    ctx.backorders.createBackorder(scheduleInput, key),
  );
  state.backorderId = created.backorder.id;
  if (!created.created || created.backorder.status !== 'WAITING')
    failStep(
      '3.createBackorder',
      'expected 201 WAITING',
      created.created ? 201 : 200,
      null,
      {
        status: created.backorder.status,
      },
    );
  if (created.backorder.estimatedArrivalDays !== RESTOCK_DAYS)
    failStep(
      '3.createBackorder',
      'estimatedArrivalDays differs from the answer',
      201,
      null,
      {
        estimatedArrivalDays: created.backorder.estimatedArrivalDays,
      },
    );
  pass('3.createBackorder', 201, {
    backorderId: created.backorder.id,
    folio: created.backorder.folio,
    status: created.backorder.status,
    queuePosition: created.backorder.queuePosition,
    referencePriceCents: created.backorder.referencePriceCents,
    phonePresent: created.backorder.phone != null,
  });

  const replay = await bot('3.replayBackorder', () =>
    ctx.backorders.createBackorder(scheduleInput, key),
  );
  if (replay.created || replay.backorder.id !== created.backorder.id)
    failStep(
      '3.replayBackorder',
      'same key must replay 200 with the same backorder',
      replay.created ? 201 : 200,
    );
  pass('3.replayBackorder', 200, { sameBackorder: true });

  const mine = await bot('3.listByPhone', () =>
    ctx.backorders.listBackorders({
      phoneCountryCode: TEST_PHONE_COUNTRY_CODE,
      phone: TEST_PHONE,
      status: 'WAITING,RESERVED',
    }),
  );
  if (!mine.some((backorder) => backorder.id === created.backorder.id))
    failStep(
      '3.listByPhone',
      'the new backorder is not in the phone list',
      200,
    );
  pass('3.listByPhone', 200, {
    items: mine.length,
    phone: maskPhone(TEST_PHONE),
  });

  // 4. Stock arrives: staff adjustment +2 → RESERVED.
  const stockVersion = await readStockVersion(ctx, '4.staffStockVersion');
  pass('4.staffStockVersion', 200, { version: stockVersion });
  state.stockRaised = true;
  const raise = await adjustStock(
    ctx,
    '4.staffAdjustUp',
    stockVersion,
    QUANTITY,
    'PHYSICAL_COUNT',
    'ensayo backorder',
    'up',
  );
  if (raise.status !== 201)
    failStep(
      '4.staffAdjustUp',
      'expected 201',
      raise.status,
      errorCodeOf(raise.data),
      {
        bodyKeys: keyTree(raise.data),
      },
    );
  pass('4.staffAdjustUp', 201, { delta: QUANTITY });

  let reserved: BackorderBot | null = null;
  const reservedDeadline = Date.now() + WAIT_RESERVED_MS;
  while (Date.now() < reservedDeadline) {
    const current = await bot('4.reserved', () =>
      ctx.backorders.getBackorder(created.backorder.id),
    );
    if (current.status === 'RESERVED') {
      reserved = current;
      break;
    }
    await sleep(1000);
  }
  if (reserved === null)
    return failStep(
      '4.reserved',
      'backorder did not become RESERVED within 30 s',
      200,
    );
  const finalPriceCents = reserved.finalPriceCents;
  const msLeft =
    reserved.reservedUntil === null
      ? NaN
      : Date.parse(reserved.reservedUntil) - Date.now();
  const hours = msLeft / 3_600_000;
  if (
    finalPriceCents === null ||
    finalPriceCents <= 0 ||
    reserved.reservedAt === null ||
    !(hours > 23 && hours <= 24.1) ||
    reserved.phone == null
  )
    return failStep(
      '4.reserved',
      'RESERVED body fields out of contract',
      200,
      null,
      {
        finalPriceCents,
        reservedUntilHours: Number.isFinite(hours)
          ? Number(hours.toFixed(2))
          : null,
        phonePresent: reserved.phone != null,
      },
    );
  pass('4.reserved', 200, {
    status: reserved.status,
    finalPriceCents,
    currentPriceCents: reserved.currentPriceCents,
    referencePriceCents: reserved.referencePriceCents,
    reservedUntilHours: Number(hours.toFixed(2)),
    phonePresent: true,
  });

  // 4b. backorder.reserved on the feed.
  const reservedItem = await bot('4.feedReserved', () =>
    ctx.watcher.find(
      (item): item is BackorderFeedItem =>
        isBackorderItem(item) &&
        item.type === 'backorder.reserved' &&
        item.payload.backorderId === created.backorder.id,
      WAIT_RESERVED_MS,
    ),
  );
  if (reservedItem === null || !isBackorderItem(reservedItem))
    return failStep(
      '4.feedReserved',
      'no backorder.reserved item for the backorder within 30 s',
      200,
    );
  const raw = reservedItem.payload.raw;
  const phoneOk =
    typeof raw.phone === 'string' &&
    raw.phone !== '' &&
    typeof raw.phoneCountryCode === 'string';
  if (
    raw.finalPriceCents !== finalPriceCents ||
    typeof raw.reservedUntil !== 'string' ||
    !phoneOk ||
    reservedItem.requestId !== null
  )
    return failStep(
      '4.feedReserved',
      'feed item fields out of contract',
      200,
      null,
      {
        finalPriceCents: raw.finalPriceCents,
        reservedUntilPresent: typeof raw.reservedUntil === 'string',
        phonePresent: phoneOk,
        requestId: reservedItem.requestId,
      },
    );
  pass('4.feedReserved', 200, {
    deliveryId: reservedItem.deliveryId,
    finalPriceCents: raw.finalPriceCents,
    reservedUntilPresent: true,
    phonePresent: true,
    conversationRefPresent: reservedItem.conversationRef !== null,
  });

  // 4c. ACK STALE (nobody is messaged: this is a rehearsal).
  if (ctx.ack) {
    const ack = await bot('4.ackStale', () =>
      ctx.bot.recordDeliveryOutcome(reservedItem.deliveryId, {
        outcome: 'STALE',
        attemptId: randomUUID(),
      }),
    );
    if (ack.kind !== 'ok' && ack.kind !== 'OUTCOME_ALREADY_RECORDED')
      return failStep('4.ackStale', 'ACK refused', null, ack.kind);
    pass('4.ackStale', 200, { result: ack.kind });
  } else
    pass(
      '4.ackStale',
      'skipped',
      { note: 'E2E_BACKORDER_ACK=0: observed only' },
      null,
      'WARN',
    );

  // 5a. Deliberately wrong checkout: unitPriceCents = final + 1.
  const checkoutFor = (unitPriceCents: number, expectedTotalCents: number) => ({
    phoneCountryCode: TEST_PHONE_COUNTRY_CODE,
    phone: TEST_PHONE,
    customer: { mode: 'createIfAbsent' as const, firstName: TEST_FIRST_NAME },
    sale: {
      cashierUserId: ctx.cashierUserId,
      items: [
        {
          productId: PRODUCT_ID,
          productName: stock.name,
          quantity: QUANTITY,
          unitPriceCents,
          backorderId: created.backorder.id,
        },
      ],
      expectedTotalCents,
      shipping: { mode: 'pickup' as const },
    },
  });
  try {
    const wrong = await ctx.bot.createCheckout(
      checkoutFor(finalPriceCents + 1, finalPriceCents * QUANTITY),
      `e2e-backorder-${ctx.runId}-wrong`,
    );
    state.saleId = wrong.sale.saleId;
    failStep(
      '5.wrongPrice',
      'a wrong price must be refused, but the checkout succeeded',
      201,
    );
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    const failure = backorderCheckoutFailure(error);
    const described = describeError(error);
    if (
      failure === null ||
      failure.code !== 'PRICE_OUT_OF_DATE' ||
      failure.status !== 409 ||
      failure.currentPriceCents !== finalPriceCents
    )
      failStep(
        '5.wrongPrice',
        'expected 409 PRICE_OUT_OF_DATE mapped with currentPriceCents = finalPriceCents',
        typeof described.http === 'number' ? described.http : null,
        typeof described.code === 'string' ? described.code : null,
        {
          mapped: failure,
          bodyKeys: keyTree(
            error instanceof ChatbotApiError ? error.responseBody : null,
          ),
        },
      );
    pass(
      '5.wrongPrice',
      409,
      { currentPriceCents: failure.currentPriceCents },
      failure.code,
    );
  }

  // 5b. Real checkout.
  const checkout = await bot('5.checkout', () =>
    ctx.bot.createCheckout(
      checkoutFor(finalPriceCents, finalPriceCents * QUANTITY),
      `e2e-backorder-${ctx.runId}-ok`,
    ),
  );
  state.saleId = checkout.sale.saleId;
  if (checkout.sale.totalCents !== finalPriceCents * QUANTITY)
    failStep(
      '5.checkout',
      'sale total differs from finalPriceCents × quantity',
      201,
      null,
      {
        totalCents: checkout.sale.totalCents,
        expected: finalPriceCents * QUANTITY,
      },
    );
  pass('5.checkout', 201, {
    saleId: checkout.sale.saleId,
    folio: checkout.sale.folio,
    totalCents: checkout.sale.totalCents,
    paymentStatus: checkout.sale.paymentStatus,
  });

  const confirmed = await bot('5.backorderConfirmed', () =>
    ctx.backorders.getBackorder(created.backorder.id),
  );
  if (
    confirmed.status !== 'CONFIRMED' ||
    confirmed.saleId !== checkout.sale.saleId
  )
    failStep(
      '5.backorderConfirmed',
      'backorder must be CONFIRMED with the sale id',
      200,
      null,
      {
        status: confirmed.status,
        saleIdMatches: confirmed.saleId === checkout.sale.saleId,
      },
    );
  pass('5.backorderConfirmed', 200, {
    status: confirmed.status,
    saleIdMatches: true,
  });
}

/** Best effort; every failure is listed in the returned array. */
async function cleanup(ctx: Context, state: State): Promise<string[]> {
  const uncleaned: string[] = [];
  const note = (message: string) => {
    uncleaned.push(message);
    line('cleanup', 'NOT_CLEANED', { message });
  };
  const staffReady = await ctx.staff.login().then(isOk, () => false);

  // 1. Sale (returns the units) or the still-active backorder.
  if (state.saleId !== null && !state.saleCancelled) {
    if (!staffReady)
      note(`sale ${state.saleId} not cancelled: staff login failed`);
    else {
      const cancel = await ctx.staff.request(
        'POST',
        `/sales/${state.saleId}/cancel`,
        {
          data: { reason: 'ORDER_ERROR' },
        },
      );
      if (isOk(cancel)) {
        state.saleCancelled = true;
        line('cleanup.cancelSale', 'ok', {
          http: cancel.status,
          saleId: state.saleId,
        });
      } else
        note(
          `sale ${state.saleId} not cancelled (http ${cancel.status}, code ${errorCodeOf(cancel.data) ?? 'none'})`,
        );
    }
  } else if (state.backorderId !== null && state.saleId === null) {
    try {
      const current = await ctx.backorders.getBackorder(state.backorderId);
      if (current.status === 'WAITING' || current.status === 'RESERVED') {
        const cancelled = await ctx.backorders.cancelBackorder(
          state.backorderId,
          'fin ensayo',
        );
        line('cleanup.cancelBackorder', 'ok', { status: cancelled.status });
      } else
        line('cleanup.cancelBackorder', 'skipped', { status: current.status });
    } catch (error) {
      const described = describeError(error);
      if (described.code === BACKORDER_ERROR.BACKORDER_NOT_CANCELLABLE)
        line('cleanup.cancelBackorder', 'ok', { note: 'already terminal' });
      else
        note(
          `backorder ${state.backorderId} not cancelled (http ${String(described.http)}, code ${String(described.code)})`,
        );
    }
  }

  // 2. Stock back to 0.
  if (state.stockRaised && !state.stockCorrected) {
    try {
      const quantity = (await ctx.bot.getStock(PRODUCT_ID)).stock.quantity;
      if (quantity === 0) {
        state.stockCorrected = true;
        line('cleanup.stock', 'ok', { note: 'already 0, nothing to correct' });
      } else if (quantity === null || quantity < 1 || quantity > QUANTITY) {
        note(
          `stock is ${String(quantity)}; expected ${QUANTITY} to correct; not adjusted`,
        );
      } else if (!staffReady) note('stock not corrected: staff login failed');
      else {
        const stockResponse = await ctx.staff.request(
          'GET',
          `/inventory/products/${PRODUCT_ID}/stock`,
        );
        const version = untrackedVersion(stockResponse.data);
        if (!isOk(stockResponse) || version === null)
          note(`stock version unreadable (http ${stockResponse.status})`);
        else {
          const down = await adjustStock(
            ctx,
            'cleanup',
            version,
            -quantity,
            'DATA_ENTRY_CORRECTION',
            'fin ensayo',
            'down',
          );
          if (down.status === 201) {
            state.stockCorrected = true;
            line('cleanup.stock', 'ok', { http: 201, delta: -quantity });
          } else
            note(
              `stock adjustment -${quantity} refused (http ${down.status}, code ${errorCodeOf(down.data) ?? 'none'})`,
            );
        }
      }
    } catch (error) {
      note(`stock correction failed: ${JSON.stringify(describeError(error))}`);
    }
  }

  // 3. Verification.
  try {
    const finalStock = await ctx.bot.getStock(PRODUCT_ID);
    const active = await activeBackordersOfProduct(ctx);
    line(
      'cleanup.verify',
      finalStock.stock.quantity === 0 && active.length === 0 ? 'ok' : 'DIRTY',
      {
        stock: finalStock.stock.quantity,
        activeBackorders: active.length,
      },
    );
    if (
      finalStock.stock.quantity !== 0 &&
      state.stockRaised &&
      !uncleaned.some((m) => m.startsWith('stock'))
    )
      note(`final stock is ${String(finalStock.stock.quantity)}, expected 0`);
    if (active.length > 0)
      note(`${active.length} active backorder(s) remain for the product`);
  } catch (error) {
    note(`final verification failed: ${JSON.stringify(describeError(error))}`);
  }
  if (state.decisionId !== null)
    line('cleanup', 'info', {
      uncleanable: `RESTOCK decision ${state.decisionId} stays RESOLVED (no delete API); test customer ${maskPhone(TEST_PHONE)} stays`,
    });
  return uncleaned;
}

function checkBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'http:' && local && url.port === '3003'
      ? `${url.protocol}//${url.host}`
      : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    process.stderr.write(`missing env: ${missing.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }
  const baseUrl = checkBaseUrl(process.env.CHATBOT_API_BASE_URL as string);
  if (baseUrl === null) {
    process.stderr.write(
      'refusing to run: CHATBOT_API_BASE_URL must be http://localhost:3003 (or 127.0.0.1:3003)\n',
    );
    process.exitCode = 2;
    return;
  }
  const serviceKey = process.env.SERVICE_KEY as string;
  const branchId = process.env.CHATBOT_API_BRANCH_ID ?? DEFAULT_BRANCH_ID;
  const cashierUserId =
    process.env.CHATBOT_API_CASHIER_USER_ID ?? DEFAULT_CASHIER_USER_ID;

  // Same config shape the Nest module reads (src/config/configuration.ts).
  const config = new ConfigService({
    chatbotApi: { baseUrl, serviceKey, branchId, cashierUserId },
  });
  // HttpModule's default provider is the global axios instance.
  const http = new HttpService(axios);
  const client = new ChatbotApiHttpClient(http, config);
  const ctx: Context = {
    bot: client,
    backorders: new BackorderHttpClient(http, config),
    staff: new StaffSession(
      baseUrl,
      process.env.E2E_STAFF_EMAIL ?? DEFAULT_STAFF_EMAIL,
      process.env.E2E_STAFF_PASSWORD ?? DEFAULT_STAFF_PASSWORD,
    ),
    watcher: new FeedWatcher(client),
    cashierUserId,
    runId: `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    ack: process.env.E2E_BACKORDER_ACK !== '0',
  };
  line('config', 'ok', {
    baseUrl,
    branchId,
    productId: PRODUCT_ID,
    phone: maskPhone(TEST_PHONE),
    ack: ctx.ack,
    runId: ctx.runId,
  });

  const state: State = {
    decisionId: null,
    backorderId: null,
    saleId: null,
    saleCancelled: false,
    stockRaised: false,
    stockCorrected: false,
  };
  let failed = false;
  let uncleaned: string[] = [];
  try {
    await rehearse(ctx, state);
  } catch (error) {
    failed = true;
    if (!(error instanceof StepFailure))
      line('rehearsal', 'ABORTED', describeError(error));
  } finally {
    uncleaned = await cleanup(ctx, state);
  }

  const failures = results.filter((result) => result.outcome === 'FAIL');
  line('summary', failed || failures.length > 0 ? 'FAILED' : 'PASSED', {
    steps: results.map(
      (result) =>
        `${result.step}:${result.outcome}:${result.http}${result.code ? `:${result.code}` : ''}`,
    ),
    notCleaned: uncleaned,
  });
  if (failed || failures.length > 0 || uncleaned.length > 0)
    process.exitCode = 1;
}

void main();
