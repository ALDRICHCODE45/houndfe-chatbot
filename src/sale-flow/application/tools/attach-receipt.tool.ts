import { tool } from 'ai';
import { z } from 'zod';

/**
 * attachReceipt — AI-SDK terminal compatibility tool factory (WU12).
 *
 * The backend §4.4.7 attachment path is owned EXCLUSIVELY by the server-side
 * durable `ReceiptAttachmentService` (it sources `capturedSaleId`, `objectKey`,
 * and `declaredAmountCents` from the durable started successor). This tool
 * stays ONLY as a compatibility registry key:
 *
 *   - `inputSchema` is a STRICT empty object: unknown model fields (saleId,
 *     mediaUrl, objectKey, token, capability, pendingMedia,
 *     declaredAmountCents, declaredDate, declaredReference — and any full
 *     sale-B payload) are REJECTED, not stripped.
 *   - `execute` performs NO Chatbot API receipt attachment and accepts or
 *     exposes no protected identifier (zero `chatbotApi.attachReceipt` calls
 *     on every path, no sale context).
 *   - A valid `{}` invocation returns the closed, stable
 *     `TERMINAL_RECEIPT_GUIDANCE` result — never a retry-inducing error.
 *
 * The factory is zero-arg: the registry cannot wire a model-controlled or
 * backend-attachment dependency into it.
 */
export const TERMINAL_RECEIPT_GUIDANCE = {
  ok: true,
  terminal: true,
  guidance:
    'Receipt images are handled by the server-owned durable receipt workflow. Do not retry this tool, and do not request or derive a sale ID, media URL, object key, token, capability, pending media, amount, date, or reference.',
} as const;

export function makeAttachReceiptTool() {
  return tool({
    description:
      'Herramienta de compatibilidad: los comprobantes de pago los procesa el flujo duradero del servidor. No la llames, no acepta datos y no adjunta nada.',
    inputSchema: z.object({}).strict(),
    execute: async () => Promise.resolve(TERMINAL_RECEIPT_GUIDANCE),
  });
}
