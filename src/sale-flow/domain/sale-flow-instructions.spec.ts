import { SYSTEM_PROMPT } from '../../llm-agent/domain/system-prompt';
import { makeRequestHumanAssistanceTool } from '../application/tools/request-human-assistance.tool';
import {
  SALE_FLOW_INSTRUCTIONS,
  SHIPPING_QUOTE_GUIDANCE_FRAGMENT,
  composeSaleFlowSystemPrompt,
} from './sale-flow-instructions';

/**
 * Contract tests for the composed sale-flow system prompt.
 *
 * Spec scenarios (Q1/Q2/Q3 slice):
 *   - composed prompt is `base + '\n\n' + slice` (one-arg composer; the
 *     boot-time bank-details seam has been deleted)
 *   - composition happens at boot, not per turn (literal is constant)
 *   - step 12 gates `getPaymentDetails` to "after `createSale` succeeds"
 *   - the human-handoff phrase is byte-identical, wrapped in a
 *     `noActivePaymentDetail` branch
 *   - step 11 carries the `promoReQuote` re-confirmation + fresh-UUID rule
 *   - marker order covers the 10-tool registry (getPaymentDetails between
 *     createSale and attachReceipt)
 */
describe('sale-flow-instructions', () => {
  const base = 'BASE_PROMPT_PLACEHOLDER';

  describe('SALE_FLOW_INSTRUCTIONS literal', () => {
    it('contains the literal refusal phrase from the base contract', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'esa función aún no está disponible',
      );
    });

    it('re-states the forbidden-slang block (voseo + regional slang)', () => {
      // SALE_FLOW_INSTRUCTIONS must reinforce the base contract, not invent
      // its own vocabulary — every banned token is listed by name.
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/voseo/i);
      for (const token of ['güey', 'chido', 'neta', 'chela', 'órale']) {
        expect(SALE_FLOW_INSTRUCTIONS.toLowerCase()).toContain(
          token.toLowerCase(),
        );
      }
    });

    it('encodes the 15-step escrow flow markers in order (with getPaymentDetails between createSale and attachReceipt, cancelSale after attachReceipt)', () => {
      const stepOrder = [
        'searchCatalog',
        'checkStock',
        'evaluateCart',
        'getCustomerByPhone',
        'upsertCustomer',
        'createSale',
        'getPaymentDetails',
        'attachReceipt',
        'cancelSale',
      ];
      let lastIndex = -1;
      for (const step of stepOrder) {
        const idx = SALE_FLOW_INSTRUCTIONS.indexOf(step);
        expect(idx).toBeGreaterThan(-1);
        expect(idx).toBeGreaterThan(lastIndex);
        lastIndex = idx;
      }
    });

    it('encodes the list-price-only rule referencing originalPriceCents / finalPriceCents / needs_human_review', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain('originalPriceCents');
      expect(SALE_FLOW_INSTRUCTIONS).toContain('finalPriceCents');
      expect(SALE_FLOW_INSTRUCTIONS).toContain('needs_human_review');
    });

    it('step 11 carries the promoReQuote re-confirmation + fresh-UUID-v4 rule', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain('promoReQuote');
      expect(SALE_FLOW_INSTRUCTIONS).toContain('recomputedTotalCents');
      expect(SALE_FLOW_INSTRUCTIONS).toContain('expectedTotalCents');
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/UUID v4/i);
    });

    it('step 12 contains the getPaymentDetails-after-createSale gating rule', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'Llama a `getPaymentDetails` después de que `createSale` confirme',
      );
    });

    it('contains the human-handoff phrase (byte-identical snapshot)', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'en un momento un agente te comparte los datos de pago',
      );
    });

    it('the human-handoff phrase appears inside a noActivePaymentDetail branch', () => {
      // Verify the byte-identical phrase is gated by the new discriminated
      // kind, not exposed unconditionally.
      const phrase = 'en un momento un agente te comparte los datos de pago';
      const phraseIdx = SALE_FLOW_INSTRUCTIONS.indexOf(phrase);
      const kindIdx = SALE_FLOW_INSTRUCTIONS.indexOf('noActivePaymentDetail');
      expect(phraseIdx).toBeGreaterThan(-1);
      expect(kindIdx).toBeGreaterThan(-1);
      // The kind label appears before the phrase (the gate is announced first).
      expect(kindIdx).toBeLessThan(phraseIdx);
    });

    it('step 14 gated cancelSale to just-confirmed sale with explicit confirm phrase (byte-identical)', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        '¿Confirmas la cancelación? Sí/No',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain('saleNotCancellable');
      expect(SALE_FLOW_INSTRUCTIONS).toContain('missingPlacedSaleId');
      const confirmIdx = SALE_FLOW_INSTRUCTIONS.indexOf(
        '¿Confirmas la cancelación? Sí/No',
      );
      const historyIdx = SALE_FLOW_INSTRUCTIONS.indexOf('getOrderHistory');
      expect(confirmIdx).toBeGreaterThan(-1);
      expect(historyIdx).toBeGreaterThan(-1);
    });
  });

  describe('grounded catalog guidance (contract presence, not model compliance)', () => {
    const steps = SALE_FLOW_INSTRUCTIONS.slice(
      SALE_FLOW_INSTRUCTIONS.indexOf('\n2. '),
      SALE_FLOW_INSTRUCTIONS.indexOf('\n6. '),
    );

    it('searches a supplied main name before asking generic questions', () => {
      expect(steps).toContain('nombre principal');
      expect(steps).toContain('sin volver a preguntar qué producto busca');
      expect(steps).toContain('dosis y forma');
      expect(steps).toContain('Nunca sustituyas dosis ni presentaciones');
    });

    it('presents actual candidates, including unavailable ones, for confirmation', () => {
      expect(steps).toContain('incluidos los agotados');
      expect(steps).toContain('nombre, presentación y precio devueltos');
      expect(steps).toContain('confirma la presentación real');
    });

    it('bounds empty-result refinement to one distinct broader query', () => {
      expect(steps).toContain(
        '`ok: true, results: []` significa sin coincidencias, no agotado',
      );
      expect(steps).toContain('como máximo una búsqueda adicional');
      expect(steps).toContain('consulta distinta con un nombre más general');
      expect(steps).toContain('solo si la inicial fue demasiado específica');
      expect(steps).toContain('No repitas consultas idénticas');
      expect(steps).toContain('pide una aclaración concreta');
    });

    it('separates errors from misses and shortage without extra model retries', () => {
      expect(steps).toContain('`ok: false` significa que no se pudo consultar');
      expect(steps).toContain(
        'no equivale a cero coincidencias ni a falta de stock',
      );
      expect(steps).toContain('No reintentes automáticamente por error');
      expect(steps).toContain('aunque `retryable: true`');
    });

    it('recovers missing identities by search, never by reconstructing names', () => {
      expect(steps).toContain('IDs reales devueltos por herramientas');
      expect(steps).toContain('Si en un turno posterior no tienes esos IDs');
      expect(steps).toContain('vuelve a buscar con `searchCatalog`');
      expect(steps).toContain('Nunca reconstruyas IDs desde nombres');
    });

    it('requires validated shortage before RESTOCK and keeps supported inquiries in scope', () => {
      expect(steps).toContain(
        'SOLO el sobre de `checkStock` con `humanAssistance`',
      );
      expect(steps).toContain(
        "`kind: 'out_of_stock'` habilita la ruta RESTOCK",
      );
      expect(steps).toContain(
        'No la actives por resultados vacíos, errores ni por el estado del catálogo',
      );
      expect(steps).toContain(
        'Las consultas de catálogo, existencias y reposición sí están cubiertas',
      );
      expect(steps).toContain(
        'no uses "esa función aún no está disponible" por una búsqueda sin coincidencias',
      );
      expect(steps).toContain('Nunca inventes una fecha de reposición');
    });
  });

  describe('replenishment ETA guidance (text contract only, not model compliance)', () => {
    it.each([false, true])(
      'supports ordinary date inquiries with shipping enabled=%s',
      (shippingQuoteAvailable) => {
        const prompt = composeSaleFlowSystemPrompt(SYSTEM_PROMPT, {
          shippingQuoteAvailable,
        });
        expect(prompt).toContain('¿Hay alguna fecha aproximada');
        expect(prompt).toContain('disponibilidad del producto?');
        expect(prompt).toContain('sin exigir compromiso de compra');
        expect(prompt).toContain(
          'no tienes una fecha de reposición confirmada',
        );
        expect(prompt).toContain(
          '`checkStock` consulta existencias, no proporciona una fecha de reposición',
        );
        expect(prompt).toContain('Nunca inventes una fecha de reposición');
        expect(prompt).not.toContain(
          'Si la conversación no se trata de una venta',
        );
        expect(prompt).toContain(
          'no para consultas de disponibilidad ni para la falta de una fecha de reposición',
        );
        expect(prompt).toContain(
          'Las preguntas de disponibilidad o fecha de reposición no activan esa frase',
        );
      },
    );

    it('keeps ETA inquiries behind product confirmation, real-ID recovery and validated shortage', () => {
      const prompt = composeSaleFlowSystemPrompt(SYSTEM_PROMPT);
      expect(prompt).toContain(
        'sigue la confirmación del paso 4 y la consulta del paso 5',
      );
      expect(prompt).toContain('confirma la presentación real devuelta');
      expect(prompt).toContain('(y variante, si aplica)');
      expect(prompt).toContain('vuelve a buscar con `searchCatalog`');
      expect(prompt).toContain('Nunca reconstruyas IDs desde nombres');
      expect(prompt).toContain(
        "SOLO el sobre de `checkStock` con `humanAssistance` y `kind: 'out_of_stock'` habilita la ruta RESTOCK",
      );
      expect(prompt).toContain(
        'Preguntar por una fecha no confirma el producto ni registra una solicitud',
      );
    });

    it('makes quantity optional without fabricating it or bypassing RESTOCK preflight', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        '`quantity` es opcional en el digest: omítela si el cliente no la indicó',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain('no supongas una unidad');
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'Su ausencia no es un requisito técnico pendiente de RESTOCK ni activa una solicitud',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'El preflight de RESTOCK sigue siendo obligatorio',
      );
    });

    it('keeps historical intake distinct from contact, notification and follow-up', () => {
      const prompt = composeSaleFlowSystemPrompt(SYSTEM_PROMPT);
      expect(prompt).toContain("outcome: 'historical_intake_recorded'");
      expect(prompt).toContain(
        'NO hubo contacto humano ni notificación al cliente',
      );
      expect(prompt).toContain(
        'no hay resolución actual, ETA, respuesta humana',
      );
      expect(prompt).toContain('no prometas seguimiento');
      expect(prompt).toContain('NO reintentes, NO escales por la vía legado');
    });
  });

  describe('customer voice boundaries (text contracts, not generated replies)', () => {
    it('conditions availability examples on verified stock and preserves unknown ETA', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain('Claro que sí 😊 Contamos con');
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'solo con existencias verificadas para esa presentación',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'Una coincidencia de catálogo no confirma existencias',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'Stock desconocido o consulta fallida no significa agotado',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'Por el momento, [presentación] está agotada. No tenemos una fecha de reposición confirmada.',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'solo si el agotamiento está confirmado y no hay fecha verificada',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'No reemplaces una fecha verificada por ese ejemplo',
      );
    });

    it('keeps the shortage call immediate without a new voice-driven consent gate', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        "Si `checkStock` devuelve ese sobre, llama a `requestHumanAssistance({ kind: 'out_of_stock'",
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'Los ejemplos de voz no agregan una confirmación ni retrasan esa llamada',
      );
    });

    it.each([false, true])(
      'separates internal intake truth from conditional copy with shipping=%s',
      (shippingQuoteAvailable) => {
        const prompt = composeSaleFlowSystemPrompt(SYSTEM_PROMPT, {
          shippingQuoteAvailable,
        });
        const description = makeRequestHumanAssistanceTool(
          {} as never,
        ).description;
        for (const instructions of [prompt, description]) {
          expect(instructions).toContain('Regla INTERNA; no la recites');
          expect(instructions).toContain(
            'Solo con registro histórico confirmado (nuevo o ya existente)',
          );
          expect(instructions).toContain(
            '¡Listo! 😊 Registramos su interés por [producto/presentación].',
          );
          expect(instructions).toContain('No implica reserva');
          expect(instructions).toContain(
            'Por el momento, no puedo confirmar que su interés haya quedado registrado.',
          );
          expect(instructions).toContain(
            'No afirmes éxito ni ausencia definitiva de registro',
          );
          expect(instructions).toContain('No fuerces una oferta de venta');
        }
      },
    );
  });

  describe('composeSaleFlowSystemPrompt', () => {
    it('returns base + "\\n\\n" + slice (one-arg composer)', () => {
      expect(composeSaleFlowSystemPrompt(base)).toBe(
        base + '\n\n' + SALE_FLOW_INSTRUCTIONS,
      );
    });

    it('composed prompt still contains the four contract strings', () => {
      const composed = composeSaleFlowSystemPrompt(base);
      expect(composed).toContain('esa función aún no está disponible');
      expect(composed).toMatch(/voseo/i);
      expect(composed).toContain('originalPriceCents');
      expect(composed).toContain('searchCatalog');
    });
  });

  describe('human-handoff prompt contract (sale-flow-tools spec)', () => {
    it('step 5 (R7) names humanAssistance + kind out_of_stock and the escalation call', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain('humanAssistance');
      expect(SALE_FLOW_INSTRUCTIONS).toContain("kind: 'out_of_stock'");
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        "requestHumanAssistance({ kind: 'out_of_stock'",
      );
    });

    it('step 8 (needs_human_review) renders the quote first and escalates on customer acceptance', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain("kind: 'needs_human_review'");
      expect(SALE_FLOW_INSTRUCTIONS).toContain('humanAssistance');
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        "requestHumanAssistance({ kind: 'needs_human_review'",
      );
      // "render quote first, escalate only when the customer decides to
      // proceed" semantics are encoded verbatim.
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'cuando el cliente decida continuar',
      );
    });

    it('step 16 (R14) names requestHumanAssistance with kind expiration_date and preserves the refusal phrase for non-tooled features only', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        "requestHumanAssistance({ kind: 'expiration_date', digest: { productId, name, question } })",
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain('expiration_date');
      // The refusal phrase stays byte-identical but is explicitly NOT the
      // R14 reply (it is reserved for functions not covered by tools).
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'esa función aún no está disponible',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/zonas de env\u00edo/i);
    });

    it('encodes the awaiting-human posture rule with the runner canned reply', () => {
      // T2b: the indefinite wait is gated on the LEGACY success shape, never a
      // bare `{ ok: true }` (the RESTOCK route also returns `ok: true`).
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        '{ ok: true, customerNotified: true }',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toContain('espera indefinidamente');
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/NO sigas intentando avanzar/i);
    });

    it('keeps every byte-identical preserved string untouched', () => {
      for (const literal of [
        'esa función aún no está disponible',
        'en un momento un agente te comparte los datos de pago',
        // The prompt references the error KIND (camelCase `promoReQuote`, the
        // pre-existing literal); `PROMO_RE_QUOTE` is the backend error code.
        'promoReQuote',
        'needs_human_review',
        '¿Confirmas la cancelación? Sí/No',
        'no hay una venta reciente por cancelar',
        'deriva a revisión humana',
      ]) {
        expect(SALE_FLOW_INSTRUCTIONS).toContain(literal);
      }
    });

    it('marks the 12-tool order with requestHumanAssistance after cancelSale (step 16)', () => {
      const stepOrder = [
        'searchCatalog',
        'checkStock',
        'evaluateCart',
        'getCustomerByPhone',
        'upsertCustomer',
        'createSale',
        'getPaymentDetails',
        'attachReceipt',
        'cancelSale',
        'requestHumanAssistance',
      ];
      let lastIndex = -1;
      for (const step of stepOrder) {
        // `requestHumanAssistance` first appears in the step-5 R7 rule; the
        // step-16 occurrence is the one that must trail `cancelSale`, so use
        // the LAST occurrence for the final marker.
        const idx =
          step === 'requestHumanAssistance'
            ? SALE_FLOW_INSTRUCTIONS.lastIndexOf(step)
            : SALE_FLOW_INSTRUCTIONS.indexOf(step);
        expect(idx).toBeGreaterThan(-1);
        expect(idx).toBeGreaterThan(lastIndex);
        lastIndex = idx;
      }
    });
  });

  describe('RESTOCK outcome disambiguation (T2b: historical record is never a notice)', () => {
    it('step 5 distinguishes the RESTOCK historical record from the legacy customerNotified: true escalation', () => {
      for (const marker of [
        "outcome: 'historical_intake_recorded'",
        'customerNotified: false',
        'customerNotified: true',
        'restock_unavailable',
      ]) {
        expect(SALE_FLOW_INSTRUCTIONS).toContain(marker);
      }
    });

    it('RESTOCK success proves no resolution, ETA, human response, future notification or provider delivery, and promises no follow-up', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/no hay resolución actual/i);
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(
        /respuesta humana, notificación futura ni entrega del proveedor/i,
      );
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/no prometas seguimiento/i);
    });

    it('RESTOCK blocked says the request could not be confirmed and forbids legacy retry/escalation or any implied notice', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/no pudo confirmarse/i);
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/NO reintentes/i);
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/NO escales por la vía legado/i);
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(
        /NO impliques que se envió un aviso/i,
      );
    });

    it('rejects the old unconditional ok:true => notified posture and keeps the wait branch-qualified', () => {
      // The previous wording treated ANY `{ ok: true }` as "customer notified +
      // wait indefinitely" — including RESTOCK. That unconditional claim is gone.
      expect(SALE_FLOW_INSTRUCTIONS).not.toContain(
        'devuelva `{ ok: true }`, NO sigas intentando avanzar',
      );
      const legacyGate = SALE_FLOW_INSTRUCTIONS.indexOf(
        '`{ ok: true, customerNotified: true }`',
      );
      const waitClaim = SALE_FLOW_INSTRUCTIONS.indexOf(
        'espera indefinidamente',
      );
      const restockCarveOut = SALE_FLOW_INSTRUCTIONS.indexOf(
        'Esta espera indefinida aplica SOLO a la ruta legado',
      );
      expect(legacyGate).toBeGreaterThan(-1);
      expect(waitClaim).toBeGreaterThan(legacyGate);
      expect(restockCarveOut).toBeGreaterThan(waitClaim);
    });

    it('legacy kinds (including default-off out_of_stock) keep the escalation + canned waiting semantics', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(
        /kind: 'out_of_stock', digest: { productId, name, variantId\?, quantity\? }/,
      );
    });

    it('the requestHumanAssistance tool description distinguishes the RESTOCK record from the legacy notice', () => {
      const tool = makeRequestHumanAssistanceTool({} as never);
      expect(tool.description).toContain(
        "outcome: 'historical_intake_recorded'",
      );
      expect(tool.description).toContain('customerNotified: false');
      expect(tool.description).toContain('customerNotified: true');
      expect(tool.description).toContain('restock_unavailable');
    });
  });

  describe('step 13 terminal receipt guidance (WU12, server-owned workflow)', () => {
    function step13(): string {
      const line = SALE_FLOW_INSTRUCTIONS.split('\n').find((l) =>
        l.startsWith('13. '),
      );
      expect(line).toBeDefined();
      return line as string;
    }

    it('replaces step 13 with the exact canonical terminal-guidance literal (WU12: server-owned evidence gates acknowledgement; without evidence, state could-not-be-associated + offer assistance; valid empty attachReceipt returns terminal guidance)', () => {
      // Canonical spec step 13: server-owned evidence gates "acknowledge pending review";
      // without evidence: state "could not be associated" + offer assistance; valid
      // empty attachReceipt result = terminal guidance, never retry, never ask protected ids.
      expect(step13()).toBe(
        '13. When the customer sends a receipt image, receipt images are handled by the server-owned durable receipt workflow: do NOT call `attachReceipt` and do NOT collect or derive a sale ID, media URL, object key, token, capability, pending media, amount, date, or reference. Only explicit server-owned evidence that the image was correlated to an active confirmed sale permits acknowledging that it is pending human review. Without that evidence, state that the receipt could not be associated and offer human assistance — do not claim attachment or pending review. If `attachReceipt` ever returns a result from a valid empty invocation, treat it as terminal guidance — never retry it and never ask the customer for any protected identifier.',
      );
      expect(SALE_FLOW_INSTRUCTIONS).not.toContain('declaredAmountCents');
      expect(SALE_FLOW_INSTRUCTIONS).not.toContain('declaredReference');
      expect(SALE_FLOW_INSTRUCTIONS).not.toContain('declaredDate');
    });

    it('preserved R7/R14 and steps 12/14 composed-once strings remain byte-identical', () => {
      for (const preserved of [
        "requestHumanAssistance({ kind: 'out_of_stock'",
        'en un momento un agente te comparte los datos de pago',
        '¿Confirmas la cancelación? Sí/No',
        'no hay una venta reciente por cancelar',
        "requestHumanAssistance({ kind: 'expiration_date', digest: { productId, name, question } })",
      ]) {
        expect(SALE_FLOW_INSTRUCTIONS).toContain(preserved);
      }
      // Each protected string is composed exactly once in the literal.
      const composed = composeSaleFlowSystemPrompt('BASE_PLACEHOLDER');
      expect(
        composed.split('en un momento un agente te comparte los datos de pago')
          .length - 1,
      ).toBe(1);
      expect(
        composed.split('¿Confirmas la cancelación? Sí/No').length - 1,
      ).toBe(1);
    });
  });

  describe('opt-in shipping guidance fragment (SQ-5C3d1)', () => {
    const canonical = base + '\n\n' + SALE_FLOW_INSTRUCTIONS;

    it('keeps the default and explicit-off composed prompt byte-identical to base + "\\n\\n" + slice and never mentions getShippingQuote', () => {
      expect(composeSaleFlowSystemPrompt(base)).toBe(canonical);
      expect(
        composeSaleFlowSystemPrompt(base, { shippingQuoteAvailable: false }),
      ).toBe(canonical);
      expect(composeSaleFlowSystemPrompt(base, {})).toBe(canonical);
      expect(SALE_FLOW_INSTRUCTIONS).not.toContain('getShippingQuote');
      expect(composeSaleFlowSystemPrompt(base)).not.toContain(
        'getShippingQuote',
      );
    });

    it('fails closed: hostile or non-boolean availability never enables the fragment', () => {
      const hostile = {
        get shippingQuoteAvailable(): boolean {
          throw new Error('hostile');
        },
      };
      expect(composeSaleFlowSystemPrompt(base, hostile)).toBe(canonical);
      expect(
        composeSaleFlowSystemPrompt(base, {
          shippingQuoteAvailable: 1 as unknown as boolean,
        }),
      ).toBe(canonical);
    });

    it('appends only the shipping fragment when shippingQuoteAvailable is true', () => {
      const enabled = composeSaleFlowSystemPrompt(base, {
        shippingQuoteAvailable: true,
      });
      expect(enabled).toBe(
        base +
          '\n\n' +
          SALE_FLOW_INSTRUCTIONS +
          SHIPPING_QUOTE_GUIDANCE_FRAGMENT,
      );
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT.length).toBeGreaterThan(0);
      expect(enabled).toContain('getShippingQuote');
    });

    it('explicitly supersedes the step-15 note and encodes approval-request semantics', () => {
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toContain(
        'este slice no cotiza envíos',
      );
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toContain('getShippingQuote');
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toContain('reused');
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toContain('quoted');
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toMatch(
        /solicitud de aprobación/i,
      );
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toMatch(
        /NO significa que un humano ya la aprobó/i,
      );
    });

    it('forbids relaying amount/credit/carrier/ref/digest and shipping_approval forgery, and requires a fresh re-quote on expiry', () => {
      const fragment = SHIPPING_QUOTE_GUIDANCE_FRAGMENT;
      for (const marker of [
        'monto',
        'crédito',
        'transportista',
        'referencia',
        'digest',
      ]) {
        expect(fragment.toLowerCase()).toContain(marker);
      }
      expect(fragment).toContain("kind: 'shipping_approval'");
      expect(fragment).toContain('unavailable');
      expect(fragment).toContain('handoff_required');
      expect(fragment).toMatch(/expir/i);
      expect(fragment).toMatch(/vuelve a llamar a `getShippingQuote`/i);
      expect(fragment).toMatch(/SQ-5D/);
    });

    it('blocks createSale for a shipping order until the SQ-5D server gate exists', () => {
      const createSaleIdx =
        SHIPPING_QUOTE_GUIDANCE_FRAGMENT.indexOf('createSale');
      expect(createSaleIdx).toBeGreaterThan(-1);
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT.indexOf('SQ-5D')).toBeGreaterThan(
        createSaleIdx,
      );
      expect(SHIPPING_QUOTE_GUIDANCE_FRAGMENT).toMatch(
        /No llames a `createSale`/,
      );
    });
  });
});
