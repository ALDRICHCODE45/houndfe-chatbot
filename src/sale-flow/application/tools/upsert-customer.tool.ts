import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * upsertCustomer — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.5: PUT `/chatbot-api/customers/by-phone`
 * (`customers:write`). Stateless; the backend upserts by phone. The
 * `address.street` field is required by the backend (`@ValidateNested`
 * with no `@IsOptional`), so the Zod schema mirrors that constraint
 * here — the model never gets a 4xx from a missing street because the
 * schema rejects it first.
 *
 * `address.state` is `z.string().max(100)` (NOT a duplicated
 * `MEXICAN_STATES` enum) — the enum list lives only in the backend
 * (`@IsIn(MEXICAN_STATES)`); an invalid state is rejected by the
 * backend and surfaces as the `validation` envelope. This avoids drift
 * between the two repos (design §Tool Design).
 */
export function makeUpsertCustomerTool(deps: ToolDeps) {
  return tool({
    description:
      'Crea o actualiza un cliente (y su dirección) por teléfono. La calle (address.street) es obligatoria.',
    inputSchema: z.object({
      firstName: z.string().min(1).max(100),
      lastName: z.string().max(100).optional(),
      phoneCountryCode: z.string().min(1).max(10),
      phone: z.string().min(1).max(20),
      preferredPaymentMethod: z.string().max(50).optional(),
      address: z.object({
        label: z.string().max(100).optional(),
        street: z.string().min(1).max(200),
        exteriorNumber: z.string().max(20).optional(),
        interiorNumber: z.string().max(20).optional(),
        zipCode: z.string().max(10).optional(),
        neighborhood: z.string().max(100).optional(),
        municipality: z.string().max(100).optional(),
        city: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        visualReferences: z.string().max(500).optional(),
        carrierPhone: z.string().max(20).optional(),
      }),
    }),
    execute: async (input) => {
      try {
        const upsert = await deps.chatbotApi.upsertCustomer(input);
        return { ok: true, ...upsert };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
