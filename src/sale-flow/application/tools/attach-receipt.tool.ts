import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * attachReceipt — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.7: POST `/chatbot-api/sales/:saleId/receipts`
 * (`sales:write`). The backend stores the receipt as `PENDING` until a
 * human confirms it via the receipt-review workflow (out of this slice).
 */
export function makeAttachReceiptTool(deps: ToolDeps) {
  return tool({
    description:
      'Adjunta el comprobante de transferencia del cliente a la venta. El comprobante queda en PENDING hasta confirmación humana.',
    inputSchema: z.object({
      saleId: z.uuid(),
      mediaUrl: z.url(),
      declaredAmountCents: z.number().int().min(1),
      declaredDate: z.iso.datetime().nullish(),
      declaredReference: z.string().min(1).nullish(),
    }),
    execute: async (input) => {
      try {
        const receipt = await deps.chatbotApi.attachReceipt(input.saleId, {
          mediaUrl: input.mediaUrl,
          declaredAmountCents: input.declaredAmountCents,
          declaredDate: input.declaredDate ?? null,
          declaredReference: input.declaredReference ?? null,
        });
        return { ok: true, ...receipt };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
