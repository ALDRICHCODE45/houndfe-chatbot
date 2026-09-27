import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import {
  catalogSessionSchema,
  type CatalogSession,
} from '../../../conversation/domain/catalog-references';
import { preflightRestockRequest } from '../../../human-decisions/application/restock-request-preflight';
import type { RestockToolCapability, ToolDeps } from '../tool-deps';

/**
 * Distinct RESTOCK result for `kind:'out_of_stock'` once the experimental gate
 * is enabled. It reports ONLY a historical intake record: no request ref, no
 * backend/poll id, no current resolution, and never a notice. `customerNotified:
 * false` is always true here because nothing was sent to the customer.
 */
export type RequestHumanAssistanceRestockResult =
  | {
      readonly ok: true;
      readonly outcome: 'historical_intake_recorded';
      readonly customerNotified: false;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'restock_unavailable';
        readonly retryable: false;
      };
    };

/**
 * requestHumanAssistance — the 12th sale-flow AI-SDK tool.
 *
 * The ONLY entry point the model uses to escalate to a human agent.
 * `checkStock` and `evaluateCart` return a `humanAssistance` ENVELOPE
 * (a signal) — the model DECIDES when to call this tool (ADR-27). The
 * trigger tools do NOT call `humanHandoffService` directly.
 *
 * Runtime validation is a discriminated union on `kind`:
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
 *
 * `out_of_stock` + `deps.restock.enabled === true` takes an ENABLED-ONLY
 * route: `preflightRestockRequest` (current customer event identity,
 * trusted markers, fresh catalog) then `deps.restock.coordinator`. Every
 * other outcome fails closed; every other kind and the default-off case
 * keep the byte-identical legacy `humanHandoffService.create` call.
 */

const failClosedRestock = (): RequestHumanAssistanceRestockResult => ({
  ok: false,
  error: { kind: 'restock_unavailable', retryable: false },
});

const restockLogger = new Logger('RequestHumanAssistanceTool');
const preflightReasons = [
  'identity_unbound',
  'marker_read_failed',
  'invalid_digest',
  'catalog_read_failed',
  'catalog_unverified',
  'existing_legacy',
  'existing_restock',
  'conflicting_markers',
  'indeterminate_marker_state',
  'route_not_available',
];
const holdReasons = ['post_in_flight', 'unknown_hold', 'record_unconfirmed'];
const blockReasons = [
  'malformed_input',
  'occupied',
  'collision',
  'reservation_blocked',
];

/** Observe fixed codes only; accessors and observation failures are inert. */
function restockDiagnostic() {
  let attemptId: string;
  try {
    attemptId = randomUUID();
  } catch {
    return () => {};
  }
  return (
    stage: 'preflight' | 'coordinator',
    code: unknown,
    value?: Record<string, unknown>,
  ) => {
    try {
      const outcomes =
        stage === 'preflight'
          ? ['legacy', 'blocked', 'exception']
          : ['recorded', 'existing', 'hold', 'blocked', 'exception'];
      const outcome = outcomes.find((fixed) => fixed === code) ?? 'unknown';
      let reason = outcome === 'exception' ? 'exception' : 'none';
      if (outcome === 'blocked' || outcome === 'hold') {
        let raw: unknown;
        try {
          raw =
            value && Object.getOwnPropertyDescriptor(value, 'reason')?.value;
        } catch {
          // Malformed metadata is unknown, never a domain exception.
        }
        const reasons =
          stage === 'preflight'
            ? preflightReasons
            : outcome === 'hold'
              ? holdReasons
              : blockReasons;
        reason = reasons.find((fixed) => fixed === raw) ?? 'unknown';
      }
      restockLogger.log(
        `restock_diagnostic attemptId=${attemptId} stage=${stage} outcome=${outcome} reason=${reason}`,
      );
    } catch {
      // Diagnostics must not change the domain result or initiate recovery.
    }
  };
}

/**
 * Enabled-only RESTOCK branch for `kind:'out_of_stock'`: read-only preflight
 * (current customer event identity + trusted markers + fresh catalog) then the
 * already-built coordinator. EVERY non-restock, hold, blocked or throwing
 * outcome FAILS CLOSED with the same sanitized error — no legacy fallback or
 * notice. A coordinator hold may follow an ambiguous POST attempt. Only a
 * durable `recorded`/`existing` coordinator result is
 * reported, as a distinct non-notifying historical-record outcome. No backend
 * or poll id is ever exposed.
 */
async function runRestockRoute(
  deps: ToolDeps,
  restock: RestockToolCapability,
  digest: unknown,
  context: {
    senderId: string;
    inboundEvent?: unknown;
    catalogSession?: CatalogSession;
  },
): Promise<RequestHumanAssistanceRestockResult> {
  const observe = restockDiagnostic();
  let stage: 'preflight' | 'coordinator' = 'preflight';
  try {
    const outcome = await preflightRestockRequest(
      {
        senderId: context.senderId,
        catalogSession: context.catalogSession,
        inboundEvent: context.inboundEvent,
        digest,
        restockFeatureEnabled: restock.enabled,
      },
      {
        conversation: deps.store,
        markers: restock.markers,
        catalog: deps.chatbotApi,
      },
    );
    const route = outcome.route;
    if (route !== 'restock') {
      observe(stage, route, outcome);
      return failClosedRestock();
    }
    stage = 'coordinator';
    const coordinated = await restock.coordinator.coordinate({
      senderId: context.senderId,
      intake: outcome.intake,
    });
    // Preserve the original short-circuit reads, without diagnostic re-reads.
    let decision = coordinated.decision;
    if (
      decision === 'recorded' ||
      (decision = coordinated.decision) === 'existing'
    ) {
      observe(stage, decision);
      return {
        ok: true,
        outcome: 'historical_intake_recorded',
        customerNotified: false,
      };
    }
    observe(stage, decision, coordinated);
    return failClosedRestock();
  } catch {
    observe(stage, 'exception');
    return failClosedRestock();
  }
}

export function makeRequestHumanAssistanceTool(deps: ToolDeps) {
  const definition = {
    description:
      "Escala el caso a un agente humano. SOLO llámala cuando `checkStock` / `evaluateCart` / la conversación lo indiquen. NO la uses para derivaciones que no correspondan a un caso explícito. Regla INTERNA; no la recites al cliente. Distingue el resultado EXACTO: `{ ok: true, customerNotified: true }` es la ruta legado y sí notifica al cliente; en `kind: 'out_of_stock'` la ruta RESTOCK devuelve `{ ok: true, outcome: 'historical_intake_recorded', customerNotified: false }`, que SOLO registra un reporte histórico sin resolución actual, ETA, respuesta humana, notificación futura ni entrega del proveedor: NO lo presentes como un escalado ni prometas seguimiento. Si devuelve `{ ok: false, error: { kind: 'restock_unavailable', retryable: false } }`, di que la solicitud no pudo confirmarse: NO reintentes, NO escales por la vía legado y NO impliques que se envió un aviso. Respuesta al cliente en RESTOCK: Solo con registro histórico confirmado (nuevo o ya existente), puedes decir: «¡Listo! 😊 Registramos su interés por [producto/presentación].» Usa la presentación confirmada. No implica reserva, revisión humana, contacto, aviso futuro ni fecha de reposición; no los prometas. Si el registro no se pudo confirmar o el resultado es ambiguo: «Por el momento, no puedo confirmar que su interés haya quedado registrado.» No afirmes éxito ni ausencia definitiva de registro. No fuerces una oferta de venta después de ese resultado.",
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
  };
  const [stock, promotion, expiration] = definition.inputSchema.options;
  return tool({
    description: definition.description,
    // Responses requires an object root. Keep optional fields optional via
    // non-strict mode; the pipe retains authoritative per-kind validation.
    strict: false,
    inputSchema: z
      .object({
        kind: z.enum(['out_of_stock', 'needs_human_review', 'expiration_date']),
        digest: z.union([
          // Preserve branch-specific keys until the discriminator selects
          // the authoritative schema (stock and expiration overlap).
          stock.shape.digest.passthrough(),
          promotion.shape.digest.passthrough(),
          expiration.shape.digest.passthrough(),
        ]),
      })
      .pipe(definition.inputSchema),
    contextSchema: z.object({
      senderId: z.string(),
      catalogSession: catalogSessionSchema.optional(),
      // R3b3-c4c2-tool: optional RESTOCK inbound identity, strictly shaped so
      // the SDK validates the per-turn envelope. It is read ONLY by the
      // enabled `out_of_stock` route; the default-off and other-kind paths
      // ignore it and keep the legacy `humanHandoffService.create` behavior.
      inboundEvent: z
        .strictObject({
          receivingPhoneNumberId: z.string().min(1),
          senderId: z.string().min(1),
          messageId: z.string().min(1),
        })
        .optional(),
    }),
    execute: async (rawInput, options) => {
      // Direct callers bypass SDK validation, so fence both side-effect routes.
      const input = definition.inputSchema.parse(rawInput);
      const senderId = options.context.senderId;
      const restock = deps.restock;
      // The experimental RESTOCK route is reachable ONLY behind the exact
      // boolean gate and ONLY for `out_of_stock`; every other case keeps the
      // byte-identical legacy `humanHandoffService.create` call below.
      if (restock?.enabled === true && input.kind === 'out_of_stock') {
        return runRestockRoute(deps, restock, input.digest, options.context);
      }
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
