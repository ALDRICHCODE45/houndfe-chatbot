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

    it('encodes the 14-step escrow flow markers in order (with getPaymentDetails between createSale and attachReceipt)', () => {
      const stepOrder = [
        'searchCatalog',
        'checkStock',
        'evaluateCart',
        'getCustomerByPhone',
        'upsertCustomer',
        'createSale',
        'getPaymentDetails',
        'attachReceipt',
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
});
