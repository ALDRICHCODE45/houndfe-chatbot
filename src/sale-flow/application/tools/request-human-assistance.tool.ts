import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import {
  catalogSessionSchema,
  type CatalogSession,
} from '../../../conversation/domain/catalog-references';
import type { RestockExistingRequestStatus } from '../../../human-decisions/application/restock-existing-request-status.service';
import { preflightRestockRequest } from '../../../human-decisions/application/restock-request-preflight';
import type { RestockToolCapability, ToolDeps } from '../tool-deps';

/**
 * Distinct RESTOCK result for `kind:'out_of_stock'` once the experimental gate
 * is enabled.
 *
 * `historical_intake_recorded` reports ONLY a historical intake record: no
 * request ref, no backend/poll id, no current resolution, and never a notice.
 * `existing_restock_recorded` reports the recovery of an ALREADY accepted
 * request; its `status` is a bare enum — never a resolution payload, ETA or
 * delivery promise — and `customerNotified: false` always holds because nothing
 * was sent to the customer.
 */
export type RequestHumanAssistanceRestockResult =
  | {
      readonly ok: true;
      readonly outcome: 'historical_intake_recorded';
      readonly customerNotified: false;
    }
  | {
      readonly ok: true;
      readonly outcome: 'existing_restock_recorded';
      readonly status: RestockExistingRequestStatus;
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

/**
 * Read a preflight `reason` WITHOUT invoking a hostile accessor: the metadata
 * may be adversarial, so a throwing getter must stay inert and never add a
 * second diagnostic or divert the result.
 */
function blockedReason(value: unknown): string | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'reason');
    const reason: unknown = descriptor?.value;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}

/** Observe fixed codes only; accessors and observation failures are inert. */
function restockDiagnostic() {
  let attemptId: string;
  try {
    attemptId = randomUUID();
  } catch {
    return () => {};
  }
  return (
    stage: 'preflight' | 'coordinator' | 'recovery',
    code: unknown,
    value?: Record<string, unknown>,
  ) => {
    try {
      const outcomes =
        stage === 'preflight'
          ? ['legacy', 'blocked', 'exception']
          : stage === 'recovery'
            ? ['recorded', 'unavailable', 'exception']
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
 *
 * The ONE exception is a preflight `existing_restock` block: an ALREADY accepted
 * request is not a failure, so it is recovered read-only (no POST, no
 * coordinator, no legacy fallback) and reported as `existing_restock_recorded`.
 * Recovery never falls through to the coordinator.
 *
 * Exported (WU-A) so the bounded `MinimalRestockRequestService` confirmation
 * gate can reuse this EXACT route with only the two ports it needs
 * (`Pick<ToolDeps, 'store' | 'chatbotApi'>`). The body, preflight call,
 * coordinator ordering, recovery and fail-closed semantics are unchanged.
 */
export async function runRestockRoute(
  deps: Pick<ToolDeps, 'store' | 'chatbotApi'>,
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
      if (
        outcome.route === 'blocked' &&
        blockedReason(outcome) === 'existing_restock'
      ) {
        return runExistingRecovery(restock, digest, context, observe);
      }
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

/**
 * Read-only recovery for a preflight `existing_restock` block. It reuses the
 * accepted local receipt, the current-state GET and the shared classifier; it
 * NEVER calls the coordinator, POSTs an intake or touches the legacy path. Only
 * a proven same-subject acceptance is reported; everything else (or a throw)
 * stays the generic `restock_unavailable` with the SAME sanitized shape.
 */
async function runExistingRecovery(
  restock: RestockToolCapability,
  digest: unknown,
  context: {
    senderId: string;
    inboundEvent?: unknown;
    catalogSession?: CatalogSession;
  },
  observe: (
    stage: 'preflight' | 'coordinator' | 'recovery',
    code: unknown,
    value?: Record<string, unknown>,
  ) => void,
): Promise<RequestHumanAssistanceRestockResult> {
  try {
    const recovery = await restock.recovery.recover({
      senderId: context.senderId,
      catalogSession: context.catalogSession,
      inboundEvent: context.inboundEvent,
      digest,
    });
    if (recovery.outcome === 'existing_restock_recorded') {
      observe('recovery', 'recorded');
      return {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: recovery.status,
        customerNotified: false,
      };
    }
    observe('recovery', 'unavailable');
    return failClosedRestock();
  } catch {
    observe('recovery', 'exception');
    return failClosedRestock();
  }
}

export function makeRequestHumanAssistanceTool(deps: ToolDeps) {
  const definition = {
    description:
      "Escala el caso a un agente humano. SOLO llámala cuando `checkStock` / `evaluateCart` / la conversación lo indiquen. NO la uses para derivaciones que no correspondan a un caso explícito. Regla INTERNA; no la recites al cliente. Distingue el resultado EXACTO: `{ ok: true, customerNotified: true }` es la ruta legado y sí notifica al cliente; en `kind: 'out_of_stock'` la ruta RESTOCK devuelve `{ ok: true, outcome: 'historical_intake_recorded', customerNotified: false }`, que confirma la aceptación de la consulta, no su estado actual. En una consulta RESTOCK ya aceptada, la ruta de recuperación devuelve `{ ok: true, outcome: 'existing_restock_recorded', status, customerNotified: false }`: `status: 'pending'` es una consulta registrada que sigue en espera de respuesta; `status: 'response_recorded'` o `status: 'stale'` significan que ya existe una respuesta registrada (vigente o ya no vigente, respectivamente); `status: 'current_status_unknown'` significa que la consulta registrada existe pero su estado actual no pudo confirmarse. En los cuatro casos reconoce que la consulta ya estaba registrada y NO ofrezcas registrarla de nuevo ni pidas permiso para ello; nunca reveles el contenido de la respuesta, ETA, fecha de reposición, notificación, contacto ni entrega; no lo trates como un fallo genérico. No acredita revisión humana, resolución actual, ETA, respuesta humana, notificación futura ni entrega del proveedor: no prometas seguimiento ni afirmes que sigue pendiente. Tampoco demuestra que no exista seguimiento: no confundas falta de evidencia con ausencia de un circuito de atención. No afirmes que un agente la leyó ni que el cliente fue notificado. Si devuelve `{ ok: false, error: { kind: 'restock_unavailable', retryable: false } }`, di que la solicitud no pudo confirmarse: NO reintentes, NO escales por la vía legado y NO impliques que se envió un aviso. Respuesta al cliente en RESTOCK: Solo con registro histórico confirmado (nuevo o ya existente), puedes decir: «Ya quedó registrada su consulta sobre cuándo tendremos [presentación] de nuevo.» Usa la presentación confirmada. En una consulta ya registrada, no afirmes que acabas de enviarla. No pidas permiso para registrar lo ya aceptado ni lo ofrezcas como lista de espera. No implica reserva, revisión humana, contacto, aviso futuro ni fecha de reposición; no los prometas. Si el registro no se pudo confirmar o el resultado es ambiguo: «Por ahora no puedo confirmar que su consulta haya quedado registrada.» No afirmes éxito ni ausencia definitiva de registro. No fuerces una oferta de venta después de ese resultado.",
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
