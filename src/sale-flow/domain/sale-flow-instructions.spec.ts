import {
  SALE_FLOW_INSTRUCTIONS,
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
      // R14 reply (it is reserved for features we never plan to tool).
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'esa función aún no está disponible',
      );
      expect(SALE_FLOW_INSTRUCTIONS).toMatch(/zonas de env\u00edo/i);
    });

    it('encodes the awaiting-human posture rule with the runner canned reply', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain('{ ok: true }');
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
});
