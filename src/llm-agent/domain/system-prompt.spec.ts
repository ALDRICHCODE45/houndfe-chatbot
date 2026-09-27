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

  it('reserves refusal for unsupported functions, not missing replenishment dates', () => {
    expect(SYSTEM_PROMPT).toContain('función realmente no cubierta');
    expect(SYSTEM_PROMPT).toContain('esa función aún no está disponible');
    expect(SYSTEM_PROMPT).toContain('sin exigir compromiso de compra');
    expect(SYSTEM_PROMPT).toContain(
      'La falta de una fecha confirmada es un dato faltante, no una función no disponible',
    );
    expect(SYSTEM_PROMPT).toContain(
      'indica que no tienes una fecha confirmada',
    );
    expect(SYSTEM_PROMPT).toContain(
      'no inventes fechas ni prometas obtenerlas',
    );
  });

  it('limits missing-date disclosures to relevant replenishment context', () => {
    expect(SYSTEM_PROMPT).toContain(
      'Si solo pregunta por disponibilidad, no anuncies la falta de fecha',
    );
    expect(SYSTEM_PROMPT).toContain(
      'Solo si falta el dato y la fecha es relevante (porque pregunta por reposición o el contexto lo requiere), indica que no tienes una fecha confirmada',
    );
  });

  it('asks only for pending confirmation of real presentations', () => {
    expect(SYSTEM_PROMPT).toContain(
      'Tras presentar candidatos reales, si falta confirmar, pregunta',
    );
    expect(SYSTEM_PROMPT).toContain('¿Buscaba esa presentación?');
    expect(SYSTEM_PROMPT).toContain('solo tras nombrarla');
    expect(SYSTEM_PROMPT).toContain('opciones reales que los distingan');
    expect(SYSTEM_PROMPT).toContain(
      'No repitas confirmación ya establecida en historial o contexto',
    );
    expect(SYSTEM_PROMPT).toContain(
      'conserva las reglas de recuperación de IDs',
    );
    expect(SYSTEM_PROMPT).toContain('No inventes opciones');
    expect(SYSTEM_PROMPT).not.toContain(
      'ni recomiendes medicamentos alternativos',
    );
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

  describe('customer voice guidance (presence, not model compliance)', () => {
    it('requires warm usted without taking a real staff identity or their private data', () => {
      expect(SYSTEM_PROMPT).toContain('cálido y cercano, siempre de usted');
      expect(SYSTEM_PROMPT).toContain('No te presentes como asesor humano');
      expect(SYSTEM_PROMPT).toContain(
        'identidad de una persona real del equipo',
      );
      expect(SYSTEM_PROMPT).toContain('datos privados');
    });

    it('reciprocates the initial greeting on the customer own time of day', () => {
      for (const rule of [
        'devuélvelo una sola vez',
        'la misma franja del día que él usó',
        'saluda neutral',
        'nunca inventes hora ni zona horaria',
        'no repitas el saludo en turnos siguientes',
      ]) {
        expect(SYSTEM_PROMPT).toContain(rule);
      }
    });

    it('treats a light friendly emoji as normal service voice, bounded, never celebratory on failures and never inside literals', () => {
      for (const rule of [
        'es parte de esta voz',
        'no un extra opcional',
        'no en cada turno',
        'puedes usarlo aunque algo no esté disponible',
        'celebrar un faltante confirmado, un error o un rechazo',
        'ni dentro de mensajes literales',
      ]) {
        expect(SYSTEM_PROMPT).toContain(rule);
      }
      // The weak "entirely optional" rule is replaced, not kept beside the new one.
      expect(SYSTEM_PROMPT).not.toContain('1–2 emojis discretos');
      expect(SYSTEM_PROMPT).not.toContain('no son obligatorios');
    });

    it('prefers gratitude at a genuine close and patience only after a real wait', () => {
      expect(SYSTEM_PROMPT).toContain(
        'ni te despidas ni cierres por preferencia antes de resolver la consulta',
      );
      expect(SYSTEM_PROMPT).toContain(
        'Sí puedes agradecer información o paciencia cuando el contexto lo amerite',
      );
      expect(SYSTEM_PROMPT).toContain(
        'Al cerrar de verdad una gestión resuelta, agradece la preferencia',
      );
      expect(SYSTEM_PROMPT).toContain(
        'agradece la paciencia solo si el contexto muestra una espera real',
      );
    });

    it('uses natural consultation language rather than an interest or waitlist offer', () => {
      expect(SYSTEM_PROMPT).toContain('consultas de reposición');
      expect(SYSTEM_PROMPT).toContain(
        'frases breves y naturales, no lenguaje de trámite',
      );
      expect(SYSTEM_PROMPT).not.toContain('registro de interés');
    });

    it('answers the stated request with useful verified details, not boilerplate', () => {
      expect(SYSTEM_PROMPT).toContain(
        'Responde primero a lo que el cliente pidió',
      );
      expect(SYSTEM_PROMPT).toContain('no preguntes "¿En qué puedo ayudarle?"');
      expect(SYSTEM_PROMPT).toContain('Omite "Sin Marca" y campos vacíos');
      expect(SYSTEM_PROMPT).toContain('sin narrar el proceso de búsqueda');
      expect(SYSTEM_PROMPT).toContain('no uses una ficha anidada');
      expect(SYSTEM_PROMPT).toContain(
        'No cierres por rutina con preguntas genéricas',
      );
      expect(SYSTEM_PROMPT).toContain('No repitas cierres como "No dude..."');
      expect(SYSTEM_PROMPT).toContain('un solo siguiente paso útil');
    });

    it('adapts identification, availability and price to the current request', () => {
      for (const rule of [
        'Un candidato relevante: respuesta breve y natural',
        'Varios candidatos: opciones breves con diferencias útiles',
        'conserva nombre, dosis y forma necesarios',
        'no infieras selección ni omitas la confirmación requerida',
        'Si la disponibilidad es relevante y está verificada, empieza por ella',
        'agotamiento confirmado, informa con calma, sin celebrar',
        'Precio verificado solo si lo pidió, ayuda a comparar o corresponde a cotización, carrito o pedido',
      ]) {
        expect(SYSTEM_PROMPT).toContain(rule);
      }
    });

    it('keeps internal evidence intact and gives required literal replies priority', () => {
      expect(SYSTEM_PROMPT).toContain(
        'Traduce IDs, marcadores técnicos y resultados internos',
      );
      expect(SYSTEM_PROMPT).toContain(
        'conserva intacta la evidencia para las herramientas',
      );
      expect(SYSTEM_PROMPT).toContain(
        'Las respuestas literales obligatorias tienen prioridad',
      );
    });
  });

  it('is non-empty and reasonably bounded', () => {
    // Sanity check only: no production code caps the prompt length or
    // truncates it before the provider call. The owner-approved voice
    // guidance (greeting/emoji/thanks) is layered on top of the preserved
    // safety guards (catalog-vs-stock, importes, UUID suppression, tool-use
    // and flow pointers), so the prompt legitimately needs headroom above
    // the previous 4000 bound.
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(200);
    expect(SYSTEM_PROMPT.length).toBeLessThan(5000);
  });
});
