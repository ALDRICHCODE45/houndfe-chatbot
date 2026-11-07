/**
 * Live conversation-quality eval for the customer route
 * (MinimalCatalogAgentService) against real OpenAI, with an in-memory
 * pet-store backend. See scripts/eval/README.md.
 *
 *   pnpm eval:conversation              # live, needs OPENAI_API_KEY
 *   pnpm eval:conversation --dry-run    # canned model, no network
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../src/conversation/infrastructure/in-memory-conversation.store';
import { CostGuardService } from '../../src/llm-agent/application/cost-guard.service';
import { MinimalCartService } from '../../src/llm-agent/application/minimal-cart.service';
import { MinimalCatalogAgentService } from '../../src/llm-agent/application/minimal-catalog-agent.service';
import { MinimalCheckoutService } from '../../src/llm-agent/application/minimal-checkout.service';
import { MinimalOrderService } from '../../src/llm-agent/application/minimal-order.service';
import { MinimalShippingService } from '../../src/llm-agent/application/minimal-shipping.service';
import type { GenerateTextFn } from '../../src/llm-agent/infrastructure/generate-text.provider';
import type { CustomerReplyInteractive } from '../../src/llm-agent/domain/customer-reply';
import { InMemoryMinimalCatalogSessionStore } from '../../src/llm-agent/infrastructure/in-memory-minimal-catalog-session.store';
import {
  checkOrders,
  checkReply,
  nextRegister,
  type CheckResult,
  type Register,
} from './checks';
import { EvalFakeApi } from './fixtures/fake-api';
import { SCENARIOS, type Scenario, type ScenarioTurn } from './scenarios';

/**
 * USD per 1M tokens (input, cached input, output). VERIFY against
 * https://openai.com/api/pricing before trusting the totals; these are the
 * published list prices as last known when this harness was written.
 */
const PRICES: Record<
  string,
  { input: number; cached: number; output: number }
> = {
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1': { input: 2.0, cached: 0.5, output: 8.0 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10.0 },
};
/** Pessimistic per-turn size used to decide whether the next turn fits. */
const INITIAL_TURN_ESTIMATE = { input: 40_000, output: 1_000 };

const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';

interface Usage {
  input: number;
  cached: number;
  output: number;
}

interface TurnRecord {
  customer: string;
  reply: string;
  /** S3 product photos sent before the reply text. */
  images: string[];
  /** S4 buttons/list sent with the reply text, as one transcript line. */
  interactive: string | null;
  tools: string[];
  llmCalls: number;
  gate: string | null;
  backend: string[];
  checks: CheckResult[];
  usd: number;
  error?: string;
}

interface ScenarioRecord {
  scenario: Scenario;
  turns: TurnRecord[];
  orders: number;
  final: CheckResult[];
  usd: number;
  stopped: boolean;
  /** Conditional turns not sent because the bot did not ask for them. */
  skipped: number;
}

class BudgetStop extends Error {}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const model = (
  process.env.EVAL_MODEL ??
  process.env.LLM_MODEL ??
  'gpt-4.1-mini'
).replace(/^openai\//, '');
const maxUsd = Number(process.env.EVAL_MAX_USD ?? '1.00');
const filter = (process.env.EVAL_SCENARIOS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function priceFor(name: string) {
  // Longest prefix wins, so "gpt-4.1-mini-2025-04-14" maps to gpt-4.1-mini.
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => name.startsWith(k));
  return key === undefined ? null : PRICES[key];
}

const price = priceFor(model);

function usdOf(u: Usage): number {
  if (price === null) return 0;
  const fresh = Math.max(0, u.input - u.cached);
  return (
    (fresh * price.input + u.cached * price.cached + u.output * price.output) /
    1e6
  );
}

let spentUsd = 0;
let maxTurnUsd =
  price === null ? 0 : usdOf({ ...INITIAL_TURN_ESTIMATE, cached: 0 });

/** Canned model for --dry-run: search once with the customer text, then reply. */
function dryRunModel(): MockLanguageModelV4 {
  const usage = {
    inputTokens: { total: 4000, noCache: 4000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 60, text: 60, reasoning: 0 },
  };
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      const prompt = options.prompt;
      const last = prompt[prompt.length - 1];
      const canSearch = (options.tools ?? []).some(
        (t) => t.name === 'searchCatalog',
      );
      if (last?.role === 'user' && canSearch) {
        const text = last.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join(' ')
          .split('\n')[0]
          .slice(0, 80);
        return Promise.resolve({
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: `dry-${Math.random()}`,
              toolName: 'searchCatalog',
              input: JSON.stringify({ q: text || 'croquetas' }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
          warnings: [],
        });
      }
      return Promise.resolve({
        content: [
          {
            type: 'text' as const,
            text: '[dry-run] Con gusto le ayudo. Encontré opciones en el catálogo de nuestra tienda de mascotas.',
          },
        ],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      });
    },
  });
}

/** Per-scenario meter shared by the wrapped generateText. */
interface Meter {
  calls: number;
  tools: string[];
  usage: Usage;
}

function meteredGenerate(meter: Meter): GenerateTextFn {
  const wrapped = async (input: Parameters<GenerateTextFn>[0]) => {
    if (!dryRun && spentUsd >= maxUsd) throw new BudgetStop('budget exhausted');
    meter.calls += 1;
    const result = await generateText(
      dryRun ? { ...input, model: dryRunModel() } : input,
    );
    const usage = result.usage;
    meter.usage.input += usage?.inputTokens ?? 0;
    meter.usage.cached += usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    meter.usage.output += usage?.outputTokens ?? 0;
    for (const step of result.steps ?? []) {
      for (const call of step.toolCalls ?? []) meter.tools.push(call.toolName);
    }
    return result;
  };
  // SAFETY: the wrapper forwards the input unchanged to the real generateText
  // and returns its result; only the generic signature is lost.
  return wrapped as unknown as GenerateTextFn;
}

function buildHarness(scenario: Scenario, meter: Meter) {
  const api = new EvalFakeApi(scenario.customer);
  const store = new InMemoryConversationStore();
  const values: Record<string, unknown> = {
    'chatbotApi.cashierUserId': CASHIER,
    llm: {
      model,
      maxSteps: Number(process.env.LLM_MAX_STEPS ?? '4'),
      historyTurns: Number(process.env.LLM_HISTORY_TURNS ?? '12'),
    },
  };
  // SAFETY: the services only call config.get with the keys in `values`.
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  const cart = new MinimalCartService(api, store);
  const checkout = new MinimalCheckoutService(api, store);
  const shipping = new MinimalShippingService(store, cart, checkout, api, {
    register: (request) => {
      api.events.push(`deliveryZoneIntake(zip ${request.zipCode ?? '?'})`);
      return Promise.resolve();
    },
  });
  const order = new MinimalOrderService(
    api,
    store,
    cart,
    checkout,
    config,
    shipping,
  );
  const agent = new MinimalCatalogAgentService(
    api,
    meteredGenerate(meter),
    new CostGuardService(10_000_000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cart,
    checkout,
    order,
    shipping,
  );
  return { api, agent };
}

/** Labels server-owned (deterministic) replies so gate behavior is visible. */
/** S4: "🔘 Botones: [a] [b]" / "📋 Lista (Ver opciones): a · b", or null. */
function describeInteractive(
  interactive: CustomerReplyInteractive | undefined,
): string | null {
  if (interactive === undefined) return null;
  return interactive.type === 'buttons'
    ? `🔘 Botones: ${interactive.buttons.map((b) => `[${b.title}]`).join(' ')}`
    : `📋 Lista (${interactive.buttonText}): ${interactive.rows
        .map((r) => r.title)
        .join(' · ')}`;
}

function gateLabel(reply: string, llmCalls: number): string | null {
  const labels: string[] = [];
  if (llmCalls === 0) labels.push('deterministic gate (no LLM call)');
  if (/^Resumen de su pedido/m.test(reply)) labels.push('order summary');
  if (/^Confirme sus datos de entrega/m.test(reply))
    labels.push('delivery confirmation');
  if (/folio/i.test(reply)) labels.push('order placed');
  return labels.length === 0 ? null : labels.join(' + ');
}

async function runScenario(scenario: Scenario): Promise<ScenarioRecord> {
  const meter: Meter = {
    calls: 0,
    tools: [],
    usage: { input: 0, cached: 0, output: 0 },
  };
  const { api, agent } = buildHarness(scenario, meter);
  const record: ScenarioRecord = {
    scenario,
    turns: [],
    orders: 0,
    final: [],
    usd: 0,
    stopped: false,
    skipped: 0,
  };
  let register: Register = 'usted';
  const customerTexts: string[] = [];
  for (const [index, raw] of scenario.turns.entries()) {
    const turn: ScenarioTurn = typeof raw === 'string' ? { text: raw } : raw;
    const previousReply = record.turns.at(-1)?.reply ?? '';
    if (
      turn.onlyIfPreviousReply !== undefined &&
      !turn.onlyIfPreviousReply.test(previousReply)
    ) {
      record.skipped += 1;
      continue;
    }
    if (!dryRun && spentUsd + maxTurnUsd > maxUsd) {
      record.stopped = true;
      break;
    }
    register = nextRegister(register, turn.text);
    customerTexts.push(turn.text);
    meter.calls = 0;
    meter.tools = [];
    const before = { ...meter.usage };
    let reply = '';
    let images: string[] = [];
    let interactive: string | null = null;
    let error: string | undefined;
    try {
      const decision = await agent.tryHandle({
        senderId: SENDER,
        text: turn.text,
        inboundEvent: {
          receivingPhoneNumberId: '123456789012345',
          senderId: SENDER,
          messageId: `wamid.eval.${scenario.id}.${index}`,
        },
      });
      reply = decision.reply;
      images = (decision.media ?? []).map(
        (media) => `${media.caption ?? '(sin pie)'} <${media.url}>`,
      );
      interactive = describeInteractive(decision.interactive);
      // The reply reached WhatsApp: arm any pending confirmation.
      decision.onSent?.();
    } catch (err) {
      if (err instanceof BudgetStop) record.stopped = true;
      error = err instanceof Error ? err.message : String(err);
    }
    const turnUsd = usdOf({
      input: meter.usage.input - before.input,
      cached: meter.usage.cached - before.cached,
      output: meter.usage.output - before.output,
    });
    spentUsd += turnUsd;
    record.usd += turnUsd;
    maxTurnUsd = Math.max(maxTurnUsd, turnUsd);
    record.turns.push({
      customer: turn.text,
      reply,
      images,
      interactive,
      tools: [...meter.tools],
      llmCalls: meter.calls,
      gate: gateLabel(reply, meter.calls),
      backend: api.drainEvents(),
      checks:
        error === undefined
          ? checkReply({
              customerText: turn.text,
              recentCustomerTexts: customerTexts,
              reply,
              expected: register,
              refusal: turn.refusal ?? 'forbidden',
              expectPersona: turn.expectPersona ?? false,
            })
          : [{ check: 'error', severity: 'fail', detail: error }],
      usd: turnUsd,
      ...(error === undefined ? {} : { error }),
    });
    if (record.stopped) break;
  }
  record.orders = api.orders.size;
  if (!record.stopped)
    record.final.push(checkOrders(scenario.expectOrders, record.orders));
  return record;
}

const icon = (s: CheckResult['severity']) =>
  s === 'fail' ? '❌' : s === 'warn' ? '⚠️' : '✅';

function transcript(records: ScenarioRecord[], startedAt: string): string {
  const lines = [
    `# Conversation eval — ${startedAt}`,
    '',
    `- Model: \`${model}\`${dryRun ? ' (DRY RUN: canned model, no OpenAI calls)' : ''}`,
    `- Budget cap: $${maxUsd.toFixed(2)} USD · spent: $${spentUsd.toFixed(4)} USD` +
      (price === null ? ' (no price entry for this model: cost unknown)' : ''),
    `- Scenarios: ${records.map((r) => r.scenario.id).join(', ')}`,
    '',
  ];
  for (const r of records) {
    lines.push(`## ${r.scenario.id} — ${r.scenario.title}`, '');
    lines.push(
      `Customer fixture: ${r.scenario.customer.kind === 'new' ? 'new (not found)' : `existing, saved address ZIP ${r.scenario.customer.zip}`} · cost $${r.usd.toFixed(4)}`,
      '',
    );
    r.turns.forEach((t, i) => {
      lines.push(`### Turn ${i + 1}`, '');
      lines.push(`**Cliente:** ${t.customer.replace(/\n/g, '  \n')}`, '');
      lines.push('**Bot:**', '');
      for (const image of t.images) lines.push(`> 🖼️ Imagen: ${image}`);
      if (t.images.length > 0) lines.push('>');
      lines.push(
        ...(t.reply === ''
          ? ['> _(no reply)_']
          : t.reply.split('\n').map((l) => `> ${l}`)),
        ...(t.interactive === null ? [] : ['>', `> ${t.interactive}`]),
        '',
      );
      lines.push(
        `- Tools: ${t.tools.length === 0 ? '—' : t.tools.join(' → ')}`,
      );
      lines.push(`- LLM calls: ${t.llmCalls} · cost $${t.usd.toFixed(4)}`);
      lines.push(`- Gate: ${t.gate ?? '—'}`);
      if (t.backend.length > 0)
        lines.push(`- Backend: ${t.backend.join('; ')}`);
      const flagged = t.checks.filter((c) => c.severity !== 'pass');
      lines.push(
        `- Checks: ${flagged.length === 0 ? '✅ all pass' : flagged.map((c) => `${icon(c.severity)} ${c.check}: ${c.detail ?? ''}`).join('; ')}`,
        '',
      );
    });
    for (const c of r.final) {
      lines.push(
        `**Orders:** ${r.orders} (expected ${r.scenario.expectOrders ?? 'any'}) ${icon(c.severity)} ${c.detail ?? ''}`,
        '',
      );
    }
    if (r.stopped) lines.push('**Stopped: budget cap reached.**', '');
  }
  return lines.join('\n');
}

function summary(records: ScenarioRecord[]): string {
  const rows = records.map((r) => {
    const all = [...r.turns.flatMap((t) => t.checks), ...r.final];
    const fails = all.filter((c) => c.severity === 'fail').length;
    const warns = all.filter((c) => c.severity === 'warn').length;
    return [
      r.scenario.id,
      `${r.turns.length}/${r.scenario.turns.length - r.skipped}`,
      String(fails),
      String(warns),
      `${r.orders}/${r.scenario.expectOrders ?? '-'}`,
      `$${r.usd.toFixed(4)}`,
      r.stopped ? 'BUDGET' : fails > 0 ? 'FAIL' : warns > 0 ? 'WARN' : 'PASS',
    ];
  });
  const header = [
    'scenario',
    'turns',
    'fail',
    'warn',
    'orders',
    'usd',
    'status',
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  const byCheck = new Map<string, { fail: number; warn: number }>();
  for (const r of records) {
    for (const c of [...r.turns.flatMap((t) => t.checks), ...r.final]) {
      const entry = byCheck.get(c.check) ?? { fail: 0, warn: 0 };
      if (c.severity === 'fail') entry.fail += 1;
      if (c.severity === 'warn') entry.warn += 1;
      byCheck.set(c.check, entry);
    }
  }
  return [
    fmt(header),
    fmt(widths.map((w) => '-'.repeat(w))),
    ...rows.map(fmt),
    '',
    'by check: ' +
      [...byCheck.entries()]
        .map(([k, v]) => `${k} ${v.fail}F/${v.warn}W`)
        .join(' · '),
  ].join('\n');
}

async function main(): Promise<void> {
  if (!dryRun && !process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY is not set (load .env first) or pass --dry-run.',
    );
    process.exit(1);
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    console.error(
      `EVAL_MAX_USD must be a positive number, got "${process.env.EVAL_MAX_USD}".`,
    );
    process.exit(1);
  }
  if (!dryRun && price === null) {
    console.error(
      `No price entry for model "${model}"; add it to PRICES in scripts/eval/conversation-eval.ts so the budget cap can work.`,
    );
    process.exit(1);
  }
  if (!process.env.EVAL_VERBOSE) Logger.overrideLogger(['error']);

  const scenarios =
    filter.length === 0
      ? SCENARIOS
      : SCENARIOS.filter((s) => filter.includes(s.id));
  const unknown = filter.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0)
    console.warn(`Unknown scenario id(s): ${unknown.join(', ')}`);

  const startedAt = new Date().toISOString();
  console.log(
    `conversation eval: model=${model} cap=$${maxUsd.toFixed(2)} scenarios=${scenarios.length}${dryRun ? ' DRY-RUN' : ''}`,
  );
  const records: ScenarioRecord[] = [];
  for (const scenario of scenarios) {
    if (!dryRun && spentUsd + maxTurnUsd > maxUsd) {
      console.log(`budget cap reached before ${scenario.id}; stopping.`);
      break;
    }
    process.stdout.write(`  ${scenario.id} … `);
    const record = await runScenario(scenario);
    records.push(record);
    console.log(`${record.turns.length} turn(s), $${record.usd.toFixed(4)}`);
    if (record.stopped) {
      console.log('budget cap reached; stopping.');
      break;
    }
  }

  const outDir = join(__dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const file = join(
    outDir,
    `${startedAt.replace(/[:.]/g, '-')}${dryRun ? '-dry-run' : ''}.md`,
  );
  writeFileSync(file, transcript(records, startedAt));
  console.log('');
  console.log(summary(records));
  console.log('');
  console.log(
    `spent: $${spentUsd.toFixed(4)} of $${maxUsd.toFixed(2)}${dryRun ? ' (simulated)' : ''}`,
  );
  console.log(`transcript: ${file}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
