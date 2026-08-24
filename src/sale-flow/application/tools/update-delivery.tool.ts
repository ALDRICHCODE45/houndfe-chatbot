import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * updateDelivery — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.8: PATCH `/chatbot-api/sales/:saleId/delivery`
 * (`sales:write`). Registered in `RealToolRegistry` (the model knows
 * it exists for future slices) but NOT exercised by this slice's
 * conversational flow — shipping is a separate slice (R2-R5).
 */
export function makeUpdateDeliveryTool(deps: ToolDeps) {
  return tool({
    description:
      'Actualiza los datos de envío de una venta (carrier, tracking, fecha estimada). Reservado para una futura integración con Skydropx.',
    inputSchema: z.object({
      saleId: z.uuid(),
      carrierName: z.string().min(1).nullish(),
      trackingRef: z.string().min(1).nullish(),
      estimatedDeliveryAt: z.iso.datetime().nullish(),
    }),
    execute: async (input) => {
      try {
        await deps.chatbotApi.updateDelivery(input.saleId, {
          carrierName: input.carrierName ?? null,
          trackingRef: input.trackingRef ?? null,
          estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
        });
        return { ok: true };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
