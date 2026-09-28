import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  'la búsqueda NUNCA prueba existencias. Cuando el cliente confirme un producto, vuelve a ' +
  'buscarlo y luego llama checkStock con su productId EXACTO. En productos con variantes ' +
  'informa existencias por variante; no iguales la del producto con la de la variante. ' +
  'No realizas compras, ventas, pagos ni cambios de datos.';

export type MinimalCatalogAgentDecision =
  | { kind: 'handled'; reply: string }
  | { kind: 'not-handled' };

// Bounded busy reply returned as `handled` (never legacy) for an in-flight turn.
const BUSY_REPLY =
  'Ya estoy atendiendo su consulta; por favor espere mi respuesta.';

const toolError = (kind: string) => ({ ok: false as const, error: kind });

// At most `maxTurns` whole turns, cut at a user boundary so no tool-call step
// is ever separated from its tool result.
function boundWholeTurns(
  messages: readonly ModelMessage[],
  maxTurns: number,
): ModelMessage[] {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue;
    seen += 1;
    if (seen >= maxTurns) return messages.slice(index);
  }
  return [...messages];
}

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
  private readonly history = new Map<string, ModelMessage[]>();
  private readonly busy = new Set<string>();

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
    const prior = boundWholeTurns(
      this.history.get(input.senderId) ?? [],
      this.historyTurns,
    );
    const runIds = new Set<string>();
    const result = await this.generateTextFn({
      model: openai(this.model),
      system: SYSTEM_PROMPT + '\n\n' + INSTRUCTIONS,
      messages: [...prior, { role: 'user', content: input.text }],
      tools: this.buildTools(runIds),
      stopWhen: stepCountIs(this.maxSteps),
    });
    this.history.set(input.senderId, [
      ...prior,
      { role: 'user', content: input.text },
      ...result.responseMessages,
    ]);
    this.costGuard.record({
      promptTokens: result.usage?.inputTokens ?? 0,
      completionTokens: result.usage?.outputTokens ?? 0,
    });
    return result.text;
  }

  private buildTools(runIds: Set<string>) {
    const chatbotApi = this.chatbotApi;
    return {
      searchCatalog: tool({
        description:
          'Busca productos por nombre. Devuelve identidad y precios reales, pero NUNCA existencias.',
        inputSchema: z.object({ q: z.string().min(1) }),
        execute: async ({ q }) => {
          try {
            const items = await chatbotApi.searchCatalog(q);
            for (const item of items) runIds.add(item.productId);
            return {
              ok: true as const,
              stock_verified: false as const,
              results: items.map(projectItem),
            };
          } catch {
            return toolError('catalog_unavailable');
          }
        },
      }),
      checkStock: tool({
        description:
          'Consulta existencias por productId de esta misma búsqueda. No acepta variantId.',
        inputSchema: z.strictObject({ productId: z.uuid() }),
        execute: async ({ productId }) => {
          if (!runIds.has(productId)) return toolError('unknown_product');
          try {
            const stock = await chatbotApi.getStock(productId);
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
            return toolError('stock_unavailable');
          }
        },
      }),
    };
  }
}
