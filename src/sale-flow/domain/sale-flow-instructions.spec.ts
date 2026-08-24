import {
  SALE_FLOW_INSTRUCTIONS,
  composeSaleFlowSystemPrompt,
  renderBankDetailsBlock,
  type BankDetails,
} from './sale-flow-instructions';

/**
 * Contract tests for the composed sale-flow system prompt.
 *
 * Spec scenarios:
 *   - composed prompt contains the four contractual strings
 *   - composed prompt is `base + '\n\n' + slice` when BankDetails is null
 *   - composed prompt appends a rendered bank block when BankDetails is set
 *   - composition happens at boot, not per turn (literal is constant)
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

    it('encodes the 14-step escrow flow markers in order', () => {
      const stepOrder = [
        'searchCatalog',
        'checkStock',
        'evaluateCart',
        'getCustomerByPhone',
        'upsertCustomer',
        'createSale',
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

    it('contains the human-handoff phrase for the bank-details-null case', () => {
      expect(SALE_FLOW_INSTRUCTIONS).toContain(
        'en un momento un agente te comparte los datos de pago',
      );
    });
  });

  describe('composeSaleFlowSystemPrompt', () => {
    it('returns base + "\\n\\n" + slice when BankDetails is null (v1 default)', () => {
      expect(composeSaleFlowSystemPrompt(base, null)).toBe(
        base + '\n\n' + SALE_FLOW_INSTRUCTIONS,
      );
    });

    it('appends a rendered bank block AFTER the slice when BankDetails is set', () => {
      const details: BankDetails = {
        bankName: 'AFIRME',
        beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV',
        clabe: '062580000000000001',
        accountNumber: '00000000001',
      };
      const composed = composeSaleFlowSystemPrompt(base, details);

      expect(composed.startsWith(base + '\n\n' + SALE_FLOW_INSTRUCTIONS)).toBe(
        true,
      );
      expect(composed).toContain('Datos bancarios para la transferencia');
      expect(composed).toContain(details.bankName);
      expect(composed).toContain(details.beneficiary);
      expect(composed).toContain(details.clabe);
      expect(composed).toContain(details.accountNumber);
    });

    it('composed prompt with BankDetails still contains the four contract strings', () => {
      const details: BankDetails = {
        bankName: 'AFIRME',
        beneficiary: 'X',
        clabe: '1',
        accountNumber: '2',
      };
      const composed = composeSaleFlowSystemPrompt(base, details);
      expect(composed).toContain('esa función aún no está disponible');
      expect(composed).toMatch(/voseo/i);
      expect(composed).toContain('originalPriceCents');
      expect(composed).toContain('searchCatalog');
    });
  });

  describe('renderBankDetailsBlock', () => {
    it('formats the four fields into a Spanish-readable block', () => {
      const block = renderBankDetailsBlock({
        bankName: 'AFIRME',
        beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV',
        clabe: '062580000000000001',
        accountNumber: '00000000001',
      });
      expect(block).toContain('AFIRME');
      expect(block).toContain('HUN F.E. COMERCIALIZADORA SA DE CV');
      expect(block).toContain('062580000000000001');
      expect(block).toContain('00000000001');
      expect(block).toContain('CLABE');
      expect(block).toContain('Beneficiario');
    });
  });
});
