/** Live rehearsal of multi-pet customer profiles (odd/tasks/multi-pet-profiles.md
 * T7, S1-S9, S14-S16; contract docs/contracts/customer-pets-bot-contract.md)
 * against the DEV backend. It drives the chatbot's REAL `ChatbotApiHttpClient`
 * (customers by-phone, pets, catalog, evaluate-cart, checkout, order history,
 * sale cancel); a staff session is used only as a fallback to cancel the test
 * sale when the bot cancel is refused.
 *
 * WRITES DEV DATA on ONE dedicated test customer (fixed fake phone `555…`,
 * first name `E2E …`): two pets, one pickup sale. A customer found by that
 * phone who is not a test customer is refused before any write. Everything
 * created is removed in a `finally` (sale cancelled, pets deleted); what could
 * not be removed is printed as NOT_CLEANED and the exit code is 1. The test
 * customer stays (the chatbot API has no customer delete).
 *
 * Refuses any base URL outside DEV_HOST_ALLOW_LIST. Never prints the service
 * key, the staff password, request headers or the phone: only step outcomes,
 * HTTP statuses, error codes and ids (every line goes through `redact`). */
import { randomUUID } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { CatalogItemResponse } from '../../src/chatbot-api/domain/dtos/catalog.dto';
import type {
  CreatePetInput,
  CustomerPet,
} from '../../src/chatbot-api/domain/dtos/customer-pets.dto';
import type { OrderHistoryResponse } from '../../src/chatbot-api/domain/dtos/sales.dto';
import { ChatbotApiHttpClient } from '../../src/chatbot-api/infrastructure/chatbot-api-http.client';
import {
  DEV_HOST_ALLOW_LIST,
  StepFailure,
  StepRunner,
  TEST_CUSTOMER_PREFIX,
  checkBaseUrl,
  checkTestPhone,
  describeError,
  exitCodeFor,
  isTestCustomerName,
  redact,
} from './pets-e2e-lib';

const REQUIRED_ENV = ['CHATBOT_API_BASE_URL', 'SERVICE_KEY'] as const;

/** Dev fixtures shared with backorder-e2e.ts. */
const DEFAULT_CASHIER_USER_ID = '1f1d646b-f1f1-4303-9f43-8d842ed18de8';
const DEFAULT_BRANCH_ID = 'ced6cc10-a037-4f41-92af-ee69bbb51c8b';
/** Documented dev demo staff account (only ever used against the allow-list). */
const DEFAULT_STAFF_EMAIL = 'manager@houndfe.com';
const DEFAULT_STAFF_PASSWORD = 'Manager123!';

const TEST_PHONE_COUNTRY_CODE = '52';
/** Clearly fake and distinct from the other e2e scripts' numbers. */
const DEFAULT_TEST_PHONE = '5550002222';
const TEST_FIRST_NAME = `${TEST_CUSTOMER_PREFIX}Pets`;
/** Pets this script creates; leftovers with these names are removed. */
const TEST_PET_NAMES = ['Max', 'Bruno'] as const;
const DEFAULT_PRODUCT_QUERIES = [
  'croquetas',
  'premios',
  'shampoo',
  'juguete',
  'collar',
  'arena',
];

interface Context {
  bot: ChatbotApiHttpClient;
  runner: StepRunner;
  baseUrl: string;
  phone: string;
  cashierUserId: string;
  runId: string;
  productQueries: string[];
  staffEmail: string;
  staffPassword: string;
}

interface State {
  customerId: string | null;
  /** Pets created by this run (id → last known version). */
  pets: Map<string, number>;
  /** Sales created by this run that still need cancelling. */
  saleIds: string[];
  maxId: string | null;
  brunoId: string | null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `YYYY-MM-DD` of a UTC date. */
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function petSummary(pet: CustomerPet): Record<string, unknown> {
  return {
    petId: pet.id,
    name: pet.name,
    status: pet.status,
    version: pet.version,
    birthDate: pet.birthDate,
    precision: pet.birthDatePrecision,
    ageLabel: pet.ageLabel,
  };
}

/* ---------------------------------------------------------------- steps */

async function step1Customer(ctx: Context, state: State): Promise<void> {
  const runner: StepRunner = ctx.runner;
  const bot: ChatbotApiHttpClient = ctx.bot;
  const before = await runner.call('1a.lookup', () =>
    bot.getCustomerByPhone(TEST_PHONE_COUNTRY_CODE, ctx.phone),
  );
  if (before.found && !isTestCustomerName(before.customer?.firstName))
    runner.fail(
      '1a.lookup',
      `the phone belongs to a customer whose first name does not start with "${TEST_CUSTOMER_PREFIX}"; refusing to touch it (set E2E_PETS_PHONE to another 555 number)`,
      { customerId: before.customer?.customerId ?? null },
      200,
    );
  runner.pass('1a.lookup', 200, {
    found: before.found,
    customerId: before.customer?.customerId ?? null,
  });

  const upsert = await runner.call('1b.upsert', () =>
    bot.upsertCustomer({
      firstName: TEST_FIRST_NAME,
      lastName: 'Ensayo',
      phoneCountryCode: TEST_PHONE_COUNTRY_CODE,
      phone: ctx.phone,
      address: {
        label: 'E2E',
        street: 'Calle Ensayo E2E',
        exteriorNumber: '1',
        zipCode: '06700',
        neighborhood: 'Roma Norte',
        municipality: 'Cuauhtémoc',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
      },
    }),
  );
  const customerId = upsert?.customer?.customerId;
  if (typeof customerId !== 'string' || customerId === '')
    runner.fail('1b.upsert', 'no customer.customerId in the upsert answer');
  if (before.found && before.customer?.customerId !== customerId)
    runner.fail('1b.upsert', 'upsert answered another customer than lookup', {
      lookupCustomerId: before.customer?.customerId ?? null,
      upsertCustomerId: customerId,
    });
  state.customerId = customerId;
  runner.pass('1b.upsert', 200, {
    status: upsert.status,
    customerId,
    addressPresent: upsert.customer.address !== null,
  });

  const after = await runner.call('1c.lookupAgain', () =>
    bot.getCustomerByPhone(TEST_PHONE_COUNTRY_CODE, ctx.phone),
  );
  if (!after.found || after.customer?.customerId !== customerId)
    runner.fail(
      '1c.lookupAgain',
      'by-phone does not resolve to the test customer',
      {
        found: after.found,
        customerId: after.customer?.customerId ?? null,
      },
      200,
    );
  if (after.customer?.pets === undefined)
    runner.fail(
      '1c.lookupAgain',
      'customer.pets is absent: the credential lacks pets:read',
      {},
      200,
    );
  runner.pass('1c.lookupAgain', 200, {
    customerId,
    activePets: after.customer.pets.length,
  });
}

/** Deletes one pet by id with the current version: one reread on a version
 *  conflict; `PET_NOT_FOUND` means already gone. */
async function deletePetById(
  ctx: Context,
  customerId: string,
  petId: string,
  version: number,
): Promise<{ ok: boolean; result: string }> {
  let current = version;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deleted = await ctx.bot.deletePet(customerId, petId, current);
    if (deleted.kind === 'ok') return { ok: true, result: 'deleted' };
    if (deleted.kind === 'PET_NOT_FOUND')
      return { ok: true, result: 'already gone' };
    if (deleted.kind !== 'PET_VERSION_CONFLICT')
      return { ok: false, result: deleted.kind };
    if (deleted.currentVersion !== null) current = deleted.currentVersion;
    else {
      const list = await ctx.bot.listPets(customerId, 'ALL');
      const pet =
        list.kind === 'ok' ? list.pets.find((p) => p.id === petId) : undefined;
      if (pet === undefined) return { ok: true, result: 'already gone' };
      current = pet.version;
    }
  }
  return { ok: false, result: 'PET_VERSION_CONFLICT' };
}

async function step2CleanLeftovers(ctx: Context, state: State): Promise<void> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const list = await runner.call('2.leftovers', () =>
    ctx.bot.listPets(customerId, 'ALL'),
  );
  if (list.kind !== 'ok')
    runner.fail('2.leftovers', 'listPets ALL refused', {}, null, list.kind);
  const leftovers = list.pets.filter((pet) =>
    (TEST_PET_NAMES as readonly string[]).includes(pet.name),
  );
  let deleted = 0;
  for (const pet of leftovers) {
    const outcome = await runner.call('2.leftovers', () =>
      deletePetById(ctx, customerId, pet.id, pet.version),
    );
    if (!outcome.ok)
      runner.fail(
        '2.leftovers',
        'could not delete a leftover test pet',
        { petId: pet.id },
        null,
        outcome.result,
      );
    deleted += 1;
  }
  runner.pass('2.leftovers', 200, {
    listed: list.pets.length,
    deletedLeftovers: deleted,
    otherPetsKept: list.pets.length - leftovers.length,
  });
}

async function step3Max(ctx: Context, state: State): Promise<CustomerPet> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const year = new Date().getUTCFullYear() - 3;
  const input: CreatePetInput = {
    name: 'Max',
    species: 'DOG',
    breed: 'Labrador',
    size: 'LARGE',
    birthDate: `${year}-06-15`,
    birthDatePrecision: 'YEAR',
  };
  const key = `e2e-pets:${ctx.runId}:max`;
  const created = await runner.call('3a.createMax', () =>
    ctx.bot.createPet(customerId, input, key),
  );
  if (created.kind !== 'ok')
    runner.fail('3a.createMax', 'create refused', {}, null, created.kind);
  state.pets.set(created.pet.id, created.pet.version);
  state.maxId = created.pet.id;
  const pet = created.pet;
  if (
    !created.created ||
    pet.name !== 'Max' ||
    pet.species !== 'DOG' ||
    pet.size !== 'LARGE' ||
    pet.birthDate !== `${year}-01-01` ||
    pet.birthDatePrecision !== 'YEAR' ||
    typeof pet.ageLabel !== 'string' ||
    !pet.ageLabel.startsWith('~') ||
    pet.status !== 'ACTIVE' ||
    pet.createdVia !== 'CHATBOT' ||
    pet.version !== 1
  )
    runner.fail('3a.createMax', 'created pet out of contract', {
      created: created.created,
      ...petSummary(pet),
      size: pet.size,
      createdVia: pet.createdVia,
    });
  runner.pass('3a.createMax', 201, {
    ...petSummary(pet),
    warnings: created.warnings,
  });

  const replay = await runner.call('3b.replayMax', () =>
    ctx.bot.createPet(customerId, input, key),
  );
  if (replay.kind !== 'ok')
    runner.fail('3b.replayMax', 'replay refused', {}, null, replay.kind);
  if (replay.pet.id !== pet.id) state.pets.set(replay.pet.id, 1);
  const identical =
    JSON.stringify({ pet: replay.pet, warnings: replay.warnings }) ===
    JSON.stringify({ pet, warnings: created.warnings });
  if (replay.created || !identical)
    runner.fail('3b.replayMax', 'same key + body must replay 200 identical', {
      created: replay.created,
      identical,
      samePetId: replay.pet.id === pet.id,
    });
  runner.pass('3b.replayMax', 200, { identical: true, petId: replay.pet.id });

  const conflict = await runner.call('3c.conflictMax', () =>
    ctx.bot.createPet(customerId, { ...input, breed: 'Golden' }, key),
  );
  if (conflict.kind === 'ok') {
    if (conflict.pet.id !== pet.id) state.pets.set(conflict.pet.id, 1);
    runner.fail('3c.conflictMax', 'changed body under the same key succeeded', {
      http: conflict.created ? 201 : 200,
    });
  }
  if (conflict.kind !== 'IDEMPOTENCY_KEY_CONFLICT')
    runner.fail(
      '3c.conflictMax',
      'expected 409 IDEMPOTENCY_KEY_CONFLICT',
      {},
      null,
      conflict.kind,
    );
  runner.passCode('3c.conflictMax', 409, conflict.kind);
  return pet;
}

async function step4Bruno(ctx: Context, state: State): Promise<CustomerPet> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const now = new Date();
  // The 20th, ten months ago: MONTH precision stores the 1st of that month.
  const born = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 10, 20),
  );
  const created = await runner.call('4.createBruno', () =>
    ctx.bot.createPet(
      customerId,
      {
        name: 'Bruno',
        species: 'DOG',
        breed: 'Chihuahua',
        size: 'SMALL',
        birthDate: isoDay(born),
        birthDatePrecision: 'MONTH',
      },
      `e2e-pets:${ctx.runId}:bruno`,
    ),
  );
  if (created.kind !== 'ok')
    runner.fail('4.createBruno', 'create refused', {}, null, created.kind);
  state.pets.set(created.pet.id, created.pet.version);
  state.brunoId = created.pet.id;
  const pet = created.pet;
  if (
    !created.created ||
    pet.birthDatePrecision !== 'MONTH' ||
    pet.birthDate !== `${isoDay(born).slice(0, 8)}01` ||
    typeof pet.ageLabel !== 'string' ||
    pet.ageLabel === '' ||
    pet.ageMonths === null ||
    pet.size !== 'SMALL' ||
    pet.status !== 'ACTIVE'
  )
    runner.fail('4.createBruno', 'created pet out of contract', {
      created: created.created,
      ...petSummary(pet),
      ageMonths: pet.ageMonths,
    });
  runner.pass('4.createBruno', 201, {
    ...petSummary(pet),
    ageMonths: pet.ageMonths,
    warnings: created.warnings,
  });
  return pet;
}

async function activePetsByPhone(
  ctx: Context,
  step: string,
  customerId: string,
): Promise<CustomerPet[]> {
  const lookup = await ctx.runner.call(step, () =>
    ctx.bot.getCustomerByPhone(TEST_PHONE_COUNTRY_CODE, ctx.phone),
  );
  if (!lookup.found || lookup.customer?.customerId !== customerId)
    ctx.runner.fail(step, 'by-phone does not resolve to the test customer');
  if (lookup.customer.pets === undefined)
    ctx.runner.fail(step, 'customer.pets is absent');
  return lookup.customer.pets;
}

async function step5ByPhone(
  ctx: Context,
  state: State,
  max: CustomerPet,
  bruno: CustomerPet,
): Promise<void> {
  const pets = await activePetsByPhone(
    ctx,
    '5.byPhonePets',
    state.customerId as string,
  );
  const found = [max, bruno].map((pet) => pets.find((p) => p.id === pet.id));
  if (found.some((pet) => pet === undefined || pet.status !== 'ACTIVE'))
    ctx.runner.fail('5.byPhonePets', 'Max and Bruno must both be ACTIVE', {
      maxListed: found[0] !== undefined,
      brunoListed: found[1] !== undefined,
    });
  ctx.runner.pass('5.byPhonePets', 200, {
    activePets: pets.length,
    names: pets.map((pet) => pet.name),
  });
}

async function step6Patch(
  ctx: Context,
  state: State,
  max: CustomerPet,
): Promise<CustomerPet> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const patched = await runner.call('6a.patchMax', () =>
    ctx.bot.patchPet(customerId, max.id, {
      version: max.version,
      allergies: 'pollo',
    }),
  );
  if (patched.kind !== 'ok')
    runner.fail('6a.patchMax', 'PATCH refused', {}, null, patched.kind);
  state.pets.set(max.id, patched.pet.version);
  if (
    patched.pet.version !== max.version + 1 ||
    patched.pet.allergies !== 'pollo'
  )
    runner.fail('6a.patchMax', 'expected version + 1 and allergies «pollo»', {
      version: patched.pet.version,
      allergies: patched.pet.allergies,
    });
  runner.pass('6a.patchMax', 200, {
    version: patched.pet.version,
    allergies: patched.pet.allergies,
  });

  const stale = await runner.call('6b.staleMax', () =>
    ctx.bot.patchPet(customerId, max.id, {
      version: max.version,
      allergies: 'pollo',
    }),
  );
  if (stale.kind === 'ok') {
    state.pets.set(max.id, stale.pet.version);
    runner.fail('6b.staleMax', 'a stale version was accepted', {
      version: stale.pet.version,
    });
  }
  if (
    stale.kind !== 'PET_VERSION_CONFLICT' ||
    stale.currentVersion !== patched.pet.version
  )
    runner.fail(
      '6b.staleMax',
      'expected 409 PET_VERSION_CONFLICT with currentVersion',
      {
        currentVersion:
          stale.kind === 'PET_VERSION_CONFLICT' ? stale.currentVersion : null,
      },
      null,
      stale.kind,
    );
  runner.passCode('6b.staleMax', 409, stale.kind, {
    currentVersion: stale.currentVersion,
  });
  return patched.pet;
}

/** Plain products with stock ≥ 2 and a price, from the catalog search. */
async function pickProducts(ctx: Context): Promise<CatalogItemResponse[]> {
  const picked = new Map<string, CatalogItemResponse>();
  for (const query of ctx.productQueries) {
    const items = await ctx.bot.searchCatalog(query, 20);
    for (const item of items) {
      if (
        item.variants.length === 0 &&
        typeof item.price.priceCents === 'number' &&
        item.price.priceCents > 0 &&
        (item.stock.status === 'available' ||
          item.stock.status === 'low_stock') &&
        typeof item.stock.quantity === 'number' &&
        item.stock.quantity >= 2
      )
        picked.set(item.productId, item);
      if (picked.size >= 2) return [...picked.values()];
    }
  }
  return [...picked.values()];
}

interface PricedLine {
  product: CatalogItemResponse;
  unitPriceCents: number;
  finalPriceCents: number;
}

async function priceLines(
  ctx: Context,
  step: string,
  products: CatalogItemResponse[],
): Promise<PricedLine[]> {
  const evaluation = await ctx.runner.call(step, () =>
    ctx.bot.evaluateCart(
      products.map((product) => ({
        productId: product.productId,
        quantity: 1,
        unitPriceCents: product.price.priceCents as number,
      })),
      { phoneCountryCode: TEST_PHONE_COUNTRY_CODE, phone: ctx.phone },
    ),
  );
  if (evaluation.items.length !== products.length)
    ctx.runner.fail(step, 'evaluate-cart answered another number of lines', {
      lines: evaluation.items.length,
    });
  return products.map((product, index) => {
    const line = evaluation.items[index];
    if (line.productId !== product.productId)
      ctx.runner.fail(step, 'evaluate-cart line order differs');
    return {
      product,
      unitPriceCents: line.unitPriceCents,
      finalPriceCents: line.finalPriceCents,
    };
  });
}

async function step7Checkout(
  ctx: Context,
  state: State,
  max: CustomerPet,
  bruno: CustomerPet,
): Promise<{ saleId: string; petLine: string; plainLine: string } | null> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const products = await runner.call('7a.checkout', () => pickProducts(ctx));
  if (products.length < 2) {
    runner.skip(
      '7a.checkout',
      `fewer than 2 plain in-stock products found for queries ${ctx.productQueries.join(',')}`,
    );
    runner.skip('7b.samePetConflict', 'no products (see 7a)');
    return null;
  }
  const [withPet, withoutPet] = products;
  const lines = await priceLines(ctx, '7a.checkout', products);
  const base = {
    phoneCountryCode: TEST_PHONE_COUNTRY_CODE,
    phone: ctx.phone,
    customer: { mode: 'existing' as const, customerId },
  };
  const checkout = await runner.call('7a.checkout', () =>
    ctx.bot.createCheckout(
      {
        ...base,
        sale: {
          cashierUserId: ctx.cashierUserId,
          items: [
            {
              productId: withPet.productId,
              productName: withPet.name,
              quantity: 1,
              unitPriceCents: lines[0].unitPriceCents,
              petId: max.id,
            },
            {
              productId: withoutPet.productId,
              productName: withoutPet.name,
              quantity: 1,
              unitPriceCents: lines[1].unitPriceCents,
            },
          ],
          expectedTotalCents:
            lines[0].finalPriceCents + lines[1].finalPriceCents,
          shipping: { mode: 'pickup' },
        },
      },
      `e2e-pets-${ctx.runId}-ok`,
    ),
  );
  state.saleIds.push(checkout.sale.saleId);
  runner.pass('7a.checkout', 201, {
    saleId: checkout.sale.saleId,
    folio: checkout.sale.folio,
    totalCents: checkout.sale.totalCents,
    petLineProductId: withPet.productId,
    plainLineProductId: withoutPet.productId,
  });

  // Same product on two lines with different pets: nothing may be created.
  // evaluate-cart itself refuses duplicate lines (DUPLICATE_CART_LINE): price
  // the product once and use that price on both lines.
  const [priced] = await priceLines(ctx, '7b.samePetConflict', [withPet]);
  const doubled = [priced, priced];
  try {
    const wrong = await ctx.bot.createCheckout(
      {
        ...base,
        sale: {
          cashierUserId: ctx.cashierUserId,
          items: [max.id, bruno.id].map((petId, index) => ({
            productId: withPet.productId,
            productName: withPet.name,
            quantity: 1,
            unitPriceCents: doubled[index].unitPriceCents,
            petId,
          })),
          expectedTotalCents:
            doubled[0].finalPriceCents + doubled[1].finalPriceCents,
          shipping: { mode: 'pickup' },
        },
      },
      `e2e-pets-${ctx.runId}-two-pets`,
    );
    state.saleIds.push(wrong.sale.saleId);
    runner.fail(
      '7b.samePetConflict',
      'two lines of the same product with different pets were accepted',
      { saleId: wrong.sale.saleId },
      201,
    );
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    const described = describeError(error);
    // The backend rejects two lines of the same product before looking at
    // their pets (live: DUPLICATE_CART_LINE); either rejection is the rule
    // (the bot never sends them: S9 merges them into one pet-less line).
    const rejected = ['INVALID_CHECKOUT_REQUEST', 'DUPLICATE_CART_LINE'];
    if (described.http !== 400 || !rejected.includes(described.code ?? ''))
      runner.fail(
        '7b.samePetConflict',
        'expected a 400 rejection (INVALID_CHECKOUT_REQUEST or DUPLICATE_CART_LINE)',
        { error: described.error },
        described.http,
        described.code,
      );
    runner.passCode('7b.samePetConflict', 400, described.code ?? '');
  }
  return {
    saleId: checkout.sale.saleId,
    petLine: withPet.productId,
    plainLine: withoutPet.productId,
  };
}

async function step8History(
  ctx: Context,
  max: CustomerPet,
  bruno: CustomerPet,
  sale: { saleId: string; petLine: string; plainLine: string } | null,
): Promise<void> {
  const runner: StepRunner = ctx.runner;
  const forMax = await runner.call('8a.historyMax', () =>
    ctx.bot.getOrderHistory(ctx.phone, TEST_PHONE_COUNTRY_CODE, {
      petId: max.id,
    }),
  );
  if (sale === null) runner.skip('8a.historyMax', 'no checkout (see 7a)');
  else {
    const order: OrderHistoryResponse | undefined = forMax.find(
      (o) => o.saleId === sale.saleId,
    );
    const petLine = order?.items.find((i) => i.productId === sale.petLine);
    const plainLine = order?.items.find((i) => i.productId === sale.plainLine);
    if (
      order === undefined ||
      petLine?.pet?.id !== max.id ||
      petLine.pet.name !== 'Max' ||
      plainLine === undefined ||
      plainLine.pet != null
    )
      runner.fail('8a.historyMax', 'order or its line pets out of contract', {
        orderFound: order !== undefined,
        petLinePet: petLine?.pet ?? null,
        plainLineFound: plainLine !== undefined,
        plainLinePet: plainLine?.pet ?? null,
      });
    runner.pass('8a.historyMax', 200, {
      orders: forMax.length,
      saleId: order.saleId,
      linePet: { id: petLine.pet.id, name: petLine.pet.name },
      plainLinePet: null,
    });
  }

  const forBruno = await runner.call('8b.historyBruno', () =>
    ctx.bot.getOrderHistory(ctx.phone, TEST_PHONE_COUNTRY_CODE, {
      petId: bruno.id,
    }),
  );
  if (forBruno.length !== 0)
    runner.fail('8b.historyBruno', 'Bruno has no orders: expected 200 []', {
      orders: forBruno.length,
    });
  runner.pass('8b.historyBruno', 200, { orders: 0 });

  try {
    await ctx.bot.getOrderHistory(ctx.phone, TEST_PHONE_COUNTRY_CODE, {
      petId: randomUUID(),
    });
    runner.fail(
      '8c.historyUnknownPet',
      'an unknown petId answered 200',
      {},
      200,
    );
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    const described = describeError(error);
    if (described.http !== 404 || described.code !== 'PET_NOT_FOUND')
      runner.fail(
        '8c.historyUnknownPet',
        'expected 404 PET_NOT_FOUND',
        { error: described.error },
        described.http,
        described.code,
      );
    runner.passCode('8c.historyUnknownPet', 404, 'PET_NOT_FOUND');
  }
}

async function step9Archive(
  ctx: Context,
  state: State,
  bruno: CustomerPet,
): Promise<CustomerPet> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const archived = await runner.call('9a.archiveBruno', () =>
    ctx.bot.archivePet(customerId, bruno.id, {
      version: bruno.version,
      reason: 'Ensayo E2E: ya no está',
    }),
  );
  if (archived.kind !== 'ok')
    runner.fail('9a.archiveBruno', 'archive refused', {}, null, archived.kind);
  state.pets.set(bruno.id, archived.pet.version);
  if (
    archived.pet.status !== 'ARCHIVED' ||
    archived.pet.archivedAt === null ||
    archived.pet.archivedReason === null ||
    archived.pet.version !== bruno.version + 1
  )
    runner.fail('9a.archiveBruno', 'archived pet out of contract', {
      ...petSummary(archived.pet),
      archivedAtPresent: archived.pet.archivedAt !== null,
      archivedReasonPresent: archived.pet.archivedReason !== null,
    });
  runner.pass('9a.archiveBruno', 200, {
    status: archived.pet.status,
    version: archived.pet.version,
  });

  const pets = await activePetsByPhone(
    ctx,
    '9b.byPhoneAfterArchive',
    customerId,
  );
  if (
    pets.some((pet) => pet.id === bruno.id) ||
    !pets.some((pet) => pet.id === state.maxId)
  )
    runner.fail(
      '9b.byPhoneAfterArchive',
      'by-phone must list Max and not Bruno',
      {
        names: pets.map((pet) => pet.name),
      },
    );
  runner.pass('9b.byPhoneAfterArchive', 200, {
    names: pets.map((pet) => pet.name),
  });

  const restored = await runner.call('9c.restoreBruno', () =>
    ctx.bot.restorePet(customerId, bruno.id, { version: archived.pet.version }),
  );
  if (restored.kind !== 'ok')
    runner.fail('9c.restoreBruno', 'restore refused', {}, null, restored.kind);
  state.pets.set(bruno.id, restored.pet.version);
  if (
    restored.pet.status !== 'ACTIVE' ||
    restored.pet.archivedAt !== null ||
    restored.pet.archivedReason !== null
  )
    runner.fail(
      '9c.restoreBruno',
      'restored pet out of contract',
      petSummary(restored.pet),
    );
  runner.pass('9c.restoreBruno', 200, {
    status: restored.pet.status,
    version: restored.pet.version,
    warnings: restored.warnings,
  });

  const again = await runner.call('9d.archiveAgain', () =>
    ctx.bot.archivePet(customerId, bruno.id, {
      version: restored.pet.version,
      reason: 'Ensayo E2E: archivar de nuevo',
    }),
  );
  if (again.kind !== 'ok')
    runner.fail('9d.archiveAgain', 'archive refused', {}, null, again.kind);
  state.pets.set(bruno.id, again.pet.version);
  if (again.pet.status !== 'ARCHIVED')
    runner.fail('9d.archiveAgain', 'expected ARCHIVED', petSummary(again.pet));
  runner.pass('9d.archiveAgain', 200, {
    status: again.pet.status,
    version: again.pet.version,
  });
  return again.pet;
}

async function step10Delete(
  ctx: Context,
  state: State,
  bruno: CustomerPet,
): Promise<void> {
  const runner: StepRunner = ctx.runner;
  const customerId = state.customerId as string;
  const deleted = await runner.call('10a.deleteBruno', () =>
    ctx.bot.deletePet(customerId, bruno.id, bruno.version),
  );
  if (deleted.kind !== 'ok')
    runner.fail('10a.deleteBruno', 'expected 204', {}, null, deleted.kind);
  state.pets.delete(bruno.id);
  runner.pass('10a.deleteBruno', 204, { petId: bruno.id });

  const again = await runner.call('10b.deleteAgain', () =>
    ctx.bot.deletePet(customerId, bruno.id, bruno.version),
  );
  if (again.kind !== 'PET_NOT_FOUND')
    runner.fail(
      '10b.deleteAgain',
      'expected 404 PET_NOT_FOUND',
      {},
      null,
      again.kind,
    );
  runner.passCode('10b.deleteAgain', 404, again.kind);
}

async function rehearse(ctx: Context, state: State): Promise<void> {
  await step1Customer(ctx, state);
  await step2CleanLeftovers(ctx, state);
  const max = await step3Max(ctx, state);
  const bruno = await step4Bruno(ctx, state);
  await step5ByPhone(ctx, state, max, bruno);
  const patchedMax = await step6Patch(ctx, state, max);
  const sale = await step7Checkout(ctx, state, patchedMax, bruno);
  await step8History(ctx, patchedMax, bruno, sale);
  const archivedBruno = await step9Archive(ctx, state, bruno);
  await step10Delete(ctx, state, archivedBruno);
}

/* -------------------------------------------------------------- cleanup */

/** Staff fallback for a sale the bot could not cancel (dev only). */
async function staffCancel(ctx: Context, saleId: string): Promise<number> {
  const http = axios.create({
    baseURL: ctx.baseUrl,
    timeout: 15_000,
    validateStatus: () => true,
  });
  try {
    const login = await http.post<unknown>('/auth/login', {
      email: ctx.staffEmail,
      password: ctx.staffPassword,
    });
    const token = (login.data as { accessToken?: unknown } | null)?.accessToken;
    if (login.status < 200 || login.status >= 300 || typeof token !== 'string')
      return login.status;
    const cancel = await http.post<unknown>(
      `/sales/${encodeURIComponent(saleId)}/cancel`,
      { reason: 'ORDER_ERROR' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return cancel.status;
  } catch {
    // Never print raw axios errors: they carry the request headers.
    return 0;
  }
}

/** Step 11. Best effort; every leftover is listed in the returned array. */
async function cleanup(ctx: Context, state: State): Promise<string[]> {
  const runner: StepRunner = ctx.runner;
  const notCleaned: string[] = [];
  const note = (message: string) => {
    notCleaned.push(message);
    runner.line('11.cleanup', 'NOT_CLEANED', { message });
  };

  for (const saleId of state.saleIds) {
    try {
      const cancelled = await ctx.bot.cancelSale(saleId, {
        reason: 'ORDER_ERROR',
        cashierUserId: ctx.cashierUserId,
      });
      runner.line('11.cancelSale', 'ok', {
        saleId,
        status: (cancelled as { status?: unknown } | null)?.status ?? null,
      });
    } catch (error) {
      const described = describeError(error);
      const staffStatus = await staffCancel(ctx, saleId);
      if (staffStatus >= 200 && staffStatus < 300)
        runner.line('11.cancelSale', 'ok', {
          saleId,
          via: 'staff',
          botHttp: described.http,
          botCode: described.code,
        });
      else
        note(
          `sale ${saleId} not cancelled (bot http ${String(described.http)} code ${String(described.code)}; staff http ${staffStatus})`,
        );
    }
  }

  const customerId = state.customerId;
  if (customerId !== null && state.pets.size > 0) {
    for (const [petId, version] of [...state.pets]) {
      try {
        const outcome = await deletePetById(ctx, customerId, petId, version);
        if (outcome.ok) {
          state.pets.delete(petId);
          runner.line('11.deletePet', 'ok', { petId, result: outcome.result });
        } else note(`pet ${petId} not deleted (${outcome.result})`);
      } catch (error) {
        note(
          `pet ${petId} not deleted (${JSON.stringify(describeError(error))})`,
        );
      }
    }
  }

  if (customerId !== null) {
    try {
      const list = await ctx.bot.listPets(customerId, 'ALL');
      if (list.kind !== 'ok') note(`final pet list refused (${list.kind})`);
      else {
        const left = list.pets.filter((pet) =>
          (TEST_PET_NAMES as readonly string[]).includes(pet.name),
        );
        runner.line('11.verify', left.length === 0 ? 'ok' : 'DIRTY', {
          testPetsLeft: left.length,
          otherPets: list.pets.length - left.length,
        });
        for (const pet of left) note(`test pet ${pet.id} still listed`);
      }
    } catch (error) {
      note(
        `final verification failed (${JSON.stringify(describeError(error))})`,
      );
    }
    runner.line('11.cleanup', 'info', {
      kept: `test customer ${customerId} stays (no customer delete in the chatbot API); cancelled sales stay in its history`,
    });
  }
  return notCleaned;
}

/* ----------------------------------------------------------------- main */

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
      `refusing to run: CHATBOT_API_BASE_URL must be http:// on one of ${DEV_HOST_ALLOW_LIST.join(', ')}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const phone = checkTestPhone(
    process.env.E2E_PETS_PHONE ?? DEFAULT_TEST_PHONE,
  );
  if (phone === null) {
    process.stderr.write(
      'refusing to run: E2E_PETS_PHONE must be a fake 10-digit number starting with 555\n',
    );
    process.exitCode = 2;
    return;
  }
  const serviceKey = process.env.SERVICE_KEY as string;
  const staffPassword =
    process.env.E2E_STAFF_PASSWORD ?? DEFAULT_STAFF_PASSWORD;
  const branchId = process.env.CHATBOT_API_BRANCH_ID ?? DEFAULT_BRANCH_ID;
  const cashierUserId =
    process.env.CHATBOT_API_CASHIER_USER_ID ?? DEFAULT_CASHIER_USER_ID;
  const productQueries = (process.env.E2E_PETS_PRODUCT_QUERIES ?? '')
    .split(',')
    .map((query) => query.trim())
    .filter((query) => query !== '');

  const runner = new StepRunner(
    (text) => process.stdout.write(text),
    [serviceKey, staffPassword],
  );
  // Same config shape the Nest module reads (src/config/configuration.ts).
  const config = new ConfigService({
    chatbotApi: { baseUrl, serviceKey, branchId, cashierUserId },
  });
  const ctx: Context = {
    bot: new ChatbotApiHttpClient(new HttpService(axios), config),
    runner,
    baseUrl,
    phone,
    cashierUserId,
    runId: `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    productQueries:
      productQueries.length > 0 ? productQueries : DEFAULT_PRODUCT_QUERIES,
    staffEmail: process.env.E2E_STAFF_EMAIL ?? DEFAULT_STAFF_EMAIL,
    staffPassword,
  };
  runner.line('config', 'ok', {
    baseUrl,
    branchId,
    phone: `***${phone.slice(-2)}`,
    runId: ctx.runId,
    productQueries: ctx.productQueries,
  });

  const state: State = {
    customerId: null,
    pets: new Map(),
    saleIds: [],
    maxId: null,
    brunoId: null,
  };
  let aborted = false;
  let notCleaned: string[] = [];
  try {
    await rehearse(ctx, state);
  } catch (error) {
    aborted = true;
    if (!(error instanceof StepFailure))
      runner.line('rehearsal', 'ABORTED', describeError(error));
  } finally {
    // Let in-flight writes settle before the cleanup reads.
    await sleep(200);
    try {
      notCleaned = await cleanup(ctx, state);
    } catch (error) {
      notCleaned = [`cleanup crashed (${describeError(error).error})`];
      runner.line('11.cleanup', 'NOT_CLEANED', { message: notCleaned[0] });
    }
  }

  const exitCode = exitCodeFor(runner.results, aborted, notCleaned);
  runner.line('summary', exitCode === 0 ? 'PASSED' : 'FAILED', {
    counts: runner.counts(),
    steps: runner.summaryEntries(),
    notCleaned,
  });
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(
    redact(`fatal: ${describeError(error).error}\n`, [
      process.env.SERVICE_KEY ?? '',
    ]),
  );
  process.exitCode = 1;
});
