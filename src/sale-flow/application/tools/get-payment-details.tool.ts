import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * getPaymentDetails — AI-SDK tool factory (Q1 / R11).
 *
 * The 10th sale-flow tool. Wraps `chatbotApi.getPaymentDetails()`
 * (`GET /chatbot-api/payment-details`, scope `payment-details:read`).
 *
 * Gating: the description tells the model to call this tool ONLY AFTER
 * `createSale` returns `ok: true`, exactly once per confirmed sale. The
 * tool itself does not gate — model-driven, not runtime-driven (R-D6).
 *
 * 404 `NO_ACTIVE_PAYMENT_DETAIL` becomes the discriminated
 * `noActivePaymentDetail` kind so the model's prompt branch in step 12
 * emits the byte-identical human-handoff phrase
 * `en un momento un agente te comparte los datos de pago`.
 *
 * `inputSchema: z.object({})` (NOT `.passthrough()`) — any extra key from
 * the model is rejected by Zod before `execute` runs.
 *
 * No `contextSchema` (no per-tool runtime seam; bank data is global, not
 * per-sender).
 */
export function makeGetPaymentDetailsTool(deps: ToolDeps) {
  return tool({
    description:
      'Obtiene los datos bancarios activos para la transferencia. Llama SOLO después de que `createSale` devuelva `ok: true`, exactamente una vez por venta confirmada.',
    inputSchema: z.object({}).strict(),
    execute: async () => {
      try {
        const paymentDetail = await deps.chatbotApi.getPaymentDetails();
        return { ok: true as const, paymentDetail };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
