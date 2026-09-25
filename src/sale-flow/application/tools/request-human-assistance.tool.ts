import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';

/**
 * requestHumanAssistance — the 12th sale-flow AI-SDK tool.
 *
 * The ONLY entry point the model uses to escalate to a human agent.
 * `checkStock` and `evaluateCart` return a `humanAssistance` ENVELOPE
 * (a signal) — the model DECIDES when to call this tool (ADR-27). The
 * trigger tools do NOT call `humanHandoffService` directly.
 *
 * `inputSchema` is a discriminated union on `kind`:
 *   - `out_of_stock`       (R7)   — product-level restock query
 *   - `needs_human_review` (promo) — backend flagged promo for review
 *   - `expiration_date`    (R14)  — customer asked about fechas de caducidad
 *
 * `shipping_approval` is RESERVED for the future R6 slice; the union
 * does NOT include it today, so the schema layer rejects it before
 * `execute`. The R6 slice will extend the union without breaking this
 * contract.
 *
 * `contextSchema: { senderId, inboundEvent? }` — the AI-SDK supplies the
 * senderId through `toolsContext.requestHumanAssistance.senderId` (see
 * `VercelAiLlmAgent.run`). The tool reads `options.context.senderId`
 * (NOT `options.context.requestHumanAssistance.senderId`) — the
 * context envelope key matches the tool name, but the inner schema is
 * uniform per the llm-agent spec §"`toolsContext` gains
 * `requestHumanAssistance.senderId`".
 */
export function makeRequestHumanAssistanceTool(deps: ToolDeps) {
  return tool({
    description:
      'Escala el caso a un agente humano. SOLO llámala cuando `checkStock` / `evaluateCart` / la conversación lo indiquen. NO la uses para derivaciones que no correspondan a un caso explícito.',
    inputSchema: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('out_of_stock'),
        digest: z.object({
          productId: z.uuid(),
          name: z.string().min(1),
          variantId: z.uuid().optional(),
          quantity: z.number().int().min(1).optional(),
        }),
      }),
      z.object({
        kind: z.literal('needs_human_review'),
        digest: z.object({
          items: z
            .array(
              z.object({
                productId: z.uuid(),
                name: z.string().optional(),
                variantId: z.uuid().optional(),
                quantity: z.number().int().min(1),
                unitPriceCents: z.number().int().min(0).optional(),
              }),
            )
            .min(1),
          originalTotalCents: z.number().int().min(0).optional(),
          recomputedTotalCents: z.number().int().min(0).optional(),
        }),
      }),
      z.object({
        kind: z.literal('expiration_date'),
        digest: z.object({
          productId: z.uuid(),
          name: z.string().min(1),
          question: z.string().min(1),
        }),
      }),
    ]),
    contextSchema: z.object({
      senderId: z.string(),
      // R3b3-c4c2: optional inert RESTOCK inbound identity. Accepted (and
      // strictly shaped) so the SDK validates the per-turn envelope, but NOT
      // yet read in `execute` — RESTOCK stays default-off/unwired and the
      // legacy `humanHandoffService.create` behavior is unchanged.
      inboundEvent: z
        .strictObject({
          receivingPhoneNumberId: z.string().min(1),
          senderId: z.string().min(1),
          messageId: z.string().min(1),
        })
        .optional(),
    }),
    execute: async (input, options) => {
      const senderId = options.context.senderId;
      // The discriminated union guarantees that `input.kind` aligns with
      // the concrete shape of `input.digest`. The cast widens the digest
      // object back to the application's discriminated-union view so the
      // service's narrowing over `digest.kind` works downstream. The
      // `kind` discriminator IS already present on `input.digest`; we
      // re-assert it for runtime paranoia.
      return deps.humanHandoffService.create({
        senderId,
        kind: input.kind,
        digest: { ...input.digest, kind: input.kind } as never,
      });
    },
  });
}
