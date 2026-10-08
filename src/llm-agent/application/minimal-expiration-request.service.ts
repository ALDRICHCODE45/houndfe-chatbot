/** EXPIRATION intake only; never polls, sends or ACKs. Registration requires a
 * confirmed receipt and durable local association; failures never imply success.
 */
import { Logger } from '@nestjs/common';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { preflightExpirationSubject } from '../../human-decisions/application/expiration-subject-preflight';
import type { ExpirationPostOrchestrator } from '../../human-decisions/application/expiration-post-orchestrator.service';
import type { SharedReservationPort } from '../../human-decisions/domain/shared-reservation';

export const MINIMAL_EXPIRATION_SESSION_TTL_MS = 5 * 60 * 1000;
export const MINIMAL_EXPIRATION_CAUTIOUS_REPLY =
  'Por ahora no puedo registrar esa consulta de información.';
export const MINIMAL_EXPIRATION_CLARIFY_REPLY =
  '¿Me confirma la presentación exacta del producto?';

export type MinimalExpirationOutcome = {
  readonly kind: 'registered' | 'existing' | 'clarify' | 'unavailable';
  readonly reply: string;
};

export interface MinimalExpirationDeps {
  readonly chatbotApi: Pick<ChatbotApiClient, 'getStock'>;
  readonly reservations: Pick<SharedReservationPort, 'reserve'>;
  readonly orchestrator: Pick<
    ExpirationPostOrchestrator,
    'orchestrateExpirationPost'
  >;
  readonly enabled: boolean;
  readonly clock?: () => number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = (): MinimalExpirationOutcome => ({
  kind: 'unavailable',
  reply: MINIMAL_EXPIRATION_CAUTIOUS_REPLY,
});

export class MinimalExpirationRequestService {
  private readonly logger = new Logger(MinimalExpirationRequestService.name);
  private readonly clock: () => number;
  constructor(private readonly deps: MinimalExpirationDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }
  get enabled(): boolean {
    return this.deps.enabled === true;
  }
  async prepare(input: {
    readonly senderId: string;
    readonly inboundEvent: unknown;
    readonly allowedProductIds: ReadonlySet<string>;
    readonly productId: string;
    readonly variantId?: string;
  }): Promise<MinimalExpirationOutcome> {
    let stage: 'validation' | 'stock' | 'grounding' | 'reservation' | 'post' =
      'validation';
    const reject = (
      reason:
        | 'disabled'
        | 'invalid_id'
        | 'unknown_product'
        | 'invalid_stock'
        | 'subject_blocked'
        | 'reservation_not_claimed'
        | 'receipt_not_recorded'
        | 'exception',
    ) => {
      // Fixed codes only: never log input, adapter reasons or raw exceptions.
      this.logger.warn(`expiration_intake stage=${stage} reason=${reason}`);
      return unavailable();
    };
    try {
      if (!this.enabled) return reject('disabled');
      if (!UUID.test(input.productId)) return reject('invalid_id');
      if (input.variantId !== undefined && !UUID.test(input.variantId)) {
        return reject('invalid_id');
      }
      if (!input.allowedProductIds.has(input.productId))
        return reject('unknown_product');
      stage = 'stock';
      let stock: StockCheckResponse;
      try {
        stock = await this.deps.chatbotApi.getStock(input.productId);
      } catch {
        return reject('exception');
      }
      const variants = stock.variants;
      if (stock.productId !== input.productId || !Array.isArray(variants)) {
        return reject('invalid_stock');
      }
      stage = 'grounding';
      const session = new CatalogSession(
        input.senderId,
        MINIMAL_EXPIRATION_SESSION_TTL_MS,
        0,
        undefined,
        [],
        this.clock,
      );
      session.installSearch(session.beginSearch(), [stock]);
      const grounded = preflightExpirationSubject({
        senderId: input.senderId,
        catalogSession: session,
        inboundEvent: input.inboundEvent,
        candidate: {
          productId: input.productId,
          variantId:
            input.variantId ?? (variants.length === 0 ? null : undefined),
        },
      });
      if (grounded.status === 'clarification') {
        return { kind: 'clarify', reply: MINIMAL_EXPIRATION_CLARIFY_REPLY };
      }
      if (grounded.status !== 'grounded') return reject('subject_blocked');
      const { intake } = grounded;
      stage = 'reservation';
      const reserved = await this.deps.reservations.reserve({
        senderId: input.senderId,
        route: 'EXPIRATION',
        requestKey: intake.sourceRequestId,
        intake,
      });
      if (reserved.action !== 'claim' && reserved.action !== 'replay') {
        return reject('reservation_not_claimed');
      }
      stage = 'post';
      const outcome = await this.deps.orchestrator.orchestrateExpirationPost({
        senderId: input.senderId,
        sourceRequestId: intake.sourceRequestId,
        intake,
      });
      if (outcome.action === 'receipt_recorded') {
        return {
          kind: 'registered',
          reply:
            '¡Listo! 😊 Su consulta ya quedó registrada con el equipo de HoundFe.',
        };
      }
      if (
        outcome.action === 'receipt_replayed' ||
        outcome.action === 'historical_receipt'
      ) {
        return {
          kind: 'existing',
          reply: 'Su consulta ya estaba registrada con el equipo de HoundFe.',
        };
      }
      return reject('receipt_not_recorded');
    } catch {
      return reject('exception');
    }
  }
}
