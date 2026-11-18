import {
  capInboundText,
  estimateLlmUsd,
  llmSpendPeriods,
  LLM_BUDGET_EXHAUSTED_REPLY,
  SENDER_LIMIT_REPLY,
} from './llm-spend';
import { applyCustomerStyle, DEFAULT_CUSTOMER_STYLE } from './customer-style';

const TU = { ...DEFAULT_CUSTOMER_STYLE, register: 'tu' as const };

describe('llm-spend domain (cost protection phase 1)', () => {
  describe('S2: calendar periods in America/Mexico_City', () => {
    it('uses the Mexico City day, not the UTC day', () => {
      // 2026-11-19 03:00 UTC is still 2026-11-18 21:00 in Mexico City.
      expect(llmSpendPeriods(new Date('2026-11-19T03:00:00.000Z'))).toEqual({
        day: '2026-11-18',
        month: '2026-11',
      });
      expect(llmSpendPeriods(new Date('2026-11-19T06:30:00.000Z'))).toEqual({
        day: '2026-11-19',
        month: '2026-11',
      });
    });

    it('rolls the month at Mexico City midnight', () => {
      expect(llmSpendPeriods(new Date('2026-12-01T05:59:00.000Z')).month).toBe(
        '2026-11',
      );
      expect(llmSpendPeriods(new Date('2026-12-01T06:00:00.000Z')).month).toBe(
        '2026-12',
      );
    });
  });

  describe('S2: USD = tokens × configured price per million tokens', () => {
    it('prices input and output separately (gpt-4o-mini defaults)', () => {
      expect(
        estimateLlmUsd(
          { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          { inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6 },
        ),
      ).toBeCloseTo(0.75, 10);
      expect(
        estimateLlmUsd(
          { inputTokens: 2_000, outputTokens: 500 },
          { inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6 },
        ),
      ).toBeCloseTo(0.0006, 10);
    });

    it('treats missing or invalid token counts as zero', () => {
      expect(
        estimateLlmUsd(
          { inputTokens: Number.NaN, outputTokens: -5 },
          { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
        ),
      ).toBe(0);
    });
  });

  describe('S4: inbound text cap', () => {
    it('keeps text at or under the cap untouched', () => {
      expect(capInboundText('hola', 1000)).toBe('hola');
      expect(capInboundText('x'.repeat(1000), 1000)).toHaveLength(1000);
    });

    it('cuts longer text to the cap', () => {
      expect(capInboundText('x'.repeat(5000), 1000)).toBe('x'.repeat(1000));
    });

    it('never leaves half of an emoji at the cut', () => {
      const text = 'x'.repeat(999) + '👍' + 'y';
      const cut = capInboundText(text, 1000);
      expect(cut).toBe('x'.repeat(999));
      expect(cut.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('verbatim customer copy (usted default, tú via customer-style)', () => {
    it('budget exhausted', () => {
      expect(LLM_BUDGET_EXHAUSTED_REPLY).toBe(
        'En este momento no puedo atenderle por aquí; ya le avisé al equipo y le escriben en cuanto puedan.',
      );
      expect(applyCustomerStyle(LLM_BUDGET_EXHAUSTED_REPLY, TU)).toBe(
        'En este momento no puedo atenderte por aquí; ya le avisé al equipo y te escriben en cuanto puedan.',
      );
    });

    it('sender limit', () => {
      expect(SENDER_LIMIT_REPLY).toBe(
        'Estamos revisando sus mensajes; en un momento le atiende alguien del equipo.',
      );
      expect(applyCustomerStyle(SENDER_LIMIT_REPLY, TU)).toBe(
        'Estamos revisando tus mensajes; en un momento te atiende alguien del equipo.',
      );
    });
  });
});
