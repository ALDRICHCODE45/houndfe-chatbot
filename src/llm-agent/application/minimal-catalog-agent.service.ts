import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { openai } from '@ai-sdk/openai';
import { stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import type { CatalogItemResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import { SYSTEM_PROMPT } from '../domain/system-prompt';
import {
  GENERATE_TEXT,
  type GenerateTextFn,
} from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';

const INSTRUCTIONS =
  'Ruta experimental de solo lectura: usa searchCatalog para localizar productos por nombre; ' +
  'la búsqueda NUNCA prueba existencias. Cuando el cliente confirme un producto ya ' +
  'identificado en esta conversación, llama checkStock directo con su productId EXACTO; ' +
  'si aún no lo está o la identidad expiró, búscalo primero. En productos con variantes ' +
  'informa existencias por variante; no iguales la del producto con la de la variante. ' +
  'No realizas compras, ventas, pagos ni cambios de datos. ' +
  'Saluda cálido de usted con un emoji ligero, según la base. Un hallazgo se anuncia ' +
  '"Encontré ... en catálogo", no "tenemos" ni "disponible": eso solo se afirma tras un ' +
  'checkStock válido. La selección explícita ya es válida: no la repreguntes. ' +
  'out_of_stock se informa claro como agotado, no "no hay disponibilidad confirmada". ' +
  'Fallo de lectura, not_managed o desconocido no son agotado. El estado del producto ' +
  'no prueba el de la variante. needs_human_review es revisión de promoción o precio, ' +
  'no una aprobación humana previa a existencias. No inventes fechas de reposición ni ' +
  'prometas registro, contacto o reservación (no existe esa herramienta). Nunca fijes ' +
  'producto, precio ni stock: los ejemplos son condicionales, no respuestas forzadas.';

export type MinimalCatalogAgentDecision =
  | { kind: 'handled'; reply: string }
  | { kind: 'not-handled' };

// Bounded busy reply returned as `handled` (never legacy) for an in-flight turn.
const BUSY_REPLY =
  'Ya estoy atendiendo su consulta; por favor espere mi respuesta.';

const toolError = (kind: string) => ({ ok: false as const, error: kind });

// Opaque per-run correlation for the local trace; never a sender, product or
// model call id. A missing CSPRNG degrades to a constant marker, not a throw.
function newTraceId(): string {
  try {
    return randomUUID();
  } catch {
    return 'unavailable';
  }
}

// Observational only: a logger throw must never change tool results, the model
// reply or the stored history.
function traceLog(logger: Logger, message: string): void {
  try {
    logger.log(message);
  } catch {
    // best-effort tracing; swallow and keep behaviour unchanged
  }
}

const STOCK_STATUSES: ReadonlySet<string> = new Set([
  'available',
  'low_stock',
  'out_of_stock',
  'not_managed',
]);

// Closed allowlist: an unexpected backend status is reported as `unknown`.
function safeStatus(status: unknown): string {
  return typeof status === 'string' && STOCK_STATUSES.has(status)
    ? status
    : 'unknown';
}

function safeQuantity(quantity: unknown): string {
  return typeof quantity === 'number' && Number.isFinite(quantity)
    ? String(quantity)
    : 'null';
}

// One whole turn per sender: the user message, the model/tool response
// messages, and only the productIds a successful fresh search produced.
type HistoryTurn = {
  messages: ModelMessage[];
  verifiedProductIds: string[];
};

// Identity + price projection with product and variant stock stripped.
function projectItem(item: CatalogItemResponse) {
  const { stock, variants, ...identity } = item;
  void stock;
  return {
    ...identity,
    variants: variants.map((variant) => {
      const { stock: variantStock, ...label } = variant;
      void variantStock;
      return label;
    }),
  };
}

// Experimental default-off read-only catalog route: direct SDK loop, in-memory
// per-sender history isolated from `ConversationStore`. No writes.
@Injectable()
export class MinimalCatalogAgentService {
  private readonly enabled: boolean;
  private readonly allowedSenders: ReadonlySet<string>;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly historyTurns: number;
  private readonly history = new Map<string, HistoryTurn[]>();
  private readonly busy = new Set<string>();
  private readonly logger = new Logger(MinimalCatalogAgentService.name);

  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly chatbotApi: ChatbotApiClient,
    @Inject(GENERATE_TEXT) private readonly generateTextFn: GenerateTextFn,
    private readonly costGuard: CostGuardService,
    config: ConfigService,
  ) {
    const agent = config.get<{ enabled: boolean; allowedSenders: string[] }>(
      'minimalCatalogAgent',
    )!;
    const llm = config.get<{
      model: string;
      maxSteps: number;
      historyTurns: number;
    }>('llm')!;
    this.enabled = agent.enabled === true;
    this.allowedSenders = new Set(agent.allowedSenders ?? []);
    this.model = llm.model;
    this.maxSteps = llm.maxSteps;
    this.historyTurns = llm.historyTurns;
  }

  // An exact allowlisted turn while enabled, else `not-handled` so the caller
  // keeps the legacy path. A same-sender run already in flight is rejected.
  async tryHandle(input: {
    senderId: string;
    text: string;
  }): Promise<MinimalCatalogAgentDecision> {
    if (!this.enabled || !this.allowedSenders.has(input.senderId)) {
      return { kind: 'not-handled' };
    }
    if (this.busy.has(input.senderId)) {
      return { kind: 'handled', reply: BUSY_REPLY };
    }
    this.busy.add(input.senderId);
    try {
      return { kind: 'handled', reply: await this.runTurn(input) };
    } finally {
      this.busy.delete(input.senderId);
    }
  }

  private async runTurn(input: {
    senderId: string;
    text: string;
  }): Promise<string> {
    const traceId = newTraceId();
    traceLog(this.logger, `minimal_catalog route_enter trace=${traceId}`);
    const turns = this.history.get(input.senderId) ?? [];
    const prior = this.historyTurns > 0 ? turns.slice(-this.historyTurns) : [];
    const allowedIds = new Set<string>();
    for (const turn of prior) {
      for (const id of turn.verifiedProductIds) allowedIds.add(id);
    }
    const currentIds = new Set<string>();
    const result = await this.generateTextFn({
      model: openai(this.model),
      system: SYSTEM_PROMPT + '\n\n' + INSTRUCTIONS,
      messages: [
        ...prior.flatMap((turn) => turn.messages),
        { role: 'user', content: input.text },
      ],
      tools: this.buildTools(allowedIds, currentIds, traceId),
      stopWhen: stepCountIs(this.maxSteps),
    });
    this.history.set(input.senderId, [
      ...prior,
      {
        messages: [
          { role: 'user', content: input.text },
          ...result.responseMessages,
        ],
        verifiedProductIds: [...currentIds],
      },
    ]);
    this.costGuard.record({
      promptTokens: result.usage?.inputTokens ?? 0,
      completionTokens: result.usage?.outputTokens ?? 0,
    });
    return result.text;
  }

  private buildTools(
    allowedIds: Set<string>,
    currentIds: Set<string>,
    traceId: string,
  ) {
    const chatbotApi = this.chatbotApi;
    const trace = (event: string) =>
      traceLog(this.logger, `minimal_catalog ${event} trace=${traceId}`);
    return {
      searchCatalog: tool({
        description:
          'Busca productos por nombre. Devuelve identidad y precios reales, pero NUNCA existencias.',
        inputSchema: z.object({ q: z.string().min(1) }),
        execute: async ({ q }) => {
          try {
            const items = await chatbotApi.searchCatalog(q);
            const results = items.map(projectItem);
            for (const item of items) {
              allowedIds.add(item.productId);
              currentIds.add(item.productId);
            }
            trace(
              `tool searchCatalog result=ok searchResultCount=${items.length}`,
            );
            return {
              ok: true as const,
              stock_verified: false as const,
              results,
            };
          } catch {
            trace('tool searchCatalog result=error code=catalog_unavailable');
            return toolError('catalog_unavailable');
          }
        },
      }),
      checkStock: tool({
        description:
          'Consulta existencias por productId ya identificado en esta conversación. No acepta variantId.',
        inputSchema: z.strictObject({ productId: z.uuid() }),
        execute: async ({ productId }) => {
          if (!allowedIds.has(productId)) {
            trace('tool checkStock result=denied code=unknown_product');
            return toolError('unknown_product');
          }
          try {
            const stock = await chatbotApi.getStock(productId);
            const status = safeStatus(stock.stock.status);
            const quantity = safeQuantity(stock.stock.quantity);
            trace(
              `tool checkStock result=ok parentStockStatus=${status} parentStockQuantity=${quantity}`,
            );
            return {
              ok: true as const,
              productId: stock.productId,
              name: stock.name,
              stock: stock.stock,
              variants: stock.variants.map((variant) => ({
                variantId: variant.variantId,
                name: variant.name,
                stock: variant.stock,
              })),
            };
          } catch {
            trace('tool checkStock result=error code=stock_unavailable');
            return toolError('stock_unavailable');
          }
        },
      }),
    };
  }
}
