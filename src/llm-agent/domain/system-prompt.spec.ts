import { SYSTEM_PROMPT } from './system-prompt';

/**
 * Contract tests for the SYSTEM_PROMPT.
 *
 * These guard against silent drift of the prompt — if anyone edits
 * SYSTEM_PROMPT in a way that breaks the no-hallucination contract,
 * the runner spec will also fail (it asserts SDK receives this exact
 * string), so this file doubles as living documentation of the contract.
 */
describe('SYSTEM_PROMPT', () => {
  // ─── Scenario: Refusal phrase and language contract ─────────────
  it('contains the literal refusal phrase verbatim', () => {
    expect(SYSTEM_PROMPT).toContain('esa función aún no está disponible');
  });

  it('mandates neutral professional Mexican Spanish', () => {
    // The prompt must say "español mexicano" (or close paraphrase) AND
    // require neutral/professional tone.
    expect(SYSTEM_PROMPT).toMatch(/español mexicano/i);
    expect(SYSTEM_PROMPT).toMatch(/neutr[ao]/i);
    expect(SYSTEM_PROMPT).toMatch(/profesional/i);
  });

  it('forbids voseo and regional slang', () => {
    expect(SYSTEM_PROMPT).toMatch(/voseo/i);
    // Specific banned tokens must be listed as forbidden examples.
    const bannedTokens = ['güey', 'chido', 'neta', 'chela', 'órale'];
    for (const token of bannedTokens) {
      expect(SYSTEM_PROMPT.toLowerCase()).toContain(token.toLowerCase());
    }
  });

  it('instructs the agent never to fabricate prices, stock, or delivery info', () => {
    expect(SYSTEM_PROMPT).toMatch(/fabri\w+/i);
    expect(SYSTEM_PROMPT).toMatch(/precios/i);
    expect(SYSTEM_PROMPT).toMatch(/existencias/i);
    expect(SYSTEM_PROMPT).toMatch(/entrega/i);
  });

  it('is non-empty and reasonably bounded', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(200);
    expect(SYSTEM_PROMPT.length).toBeLessThan(4000);
  });
});