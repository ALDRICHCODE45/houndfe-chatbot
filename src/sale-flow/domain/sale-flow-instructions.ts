/**
 * Bank-details shape (Q1 in `docs/backend-questions-sale-flow.md`).
 *
 * The chatbot NEVER hardcodes these values: they come from the swappable
 * `BankDetailsProvider` port. The v1 default returns `null`, which triggers
 * the human-handoff phrase encoded in `SALE_FLOW_INSTRUCTIONS`.
 */
export interface BankDetails {
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
}

/**
 * Sale-flow slice instructions, concatenated with the base `SYSTEM_PROMPT`
 * exactly once at module boot. Encodes the 14-step escrow-style sale flow
 * (greet → search → stock → cart → evaluate → customer → summary →
 * createSale → bank details → receipt → end) and re-states every
 * non-negotiable base contract (refusal phrase, no voseo, no fabrication,
 * list-price-only rule).
 *
 * The literal MUST stay verbatim in the four assertions
 * (`sale-flow-instructions.spec.ts`) — silent drift here is a spec break.
 */
export const SALE_FLOW_INSTRUCTIONS = `

# Flujo de venta (estilo escrow)

Sigue estos pasos, en orden, y nunca inventes datos que solo una
herramienta puede confirmar.

1. Saluda al cliente en español mexicano neutro y profesional. Nunca uses voseo, apócopes coloquiales ("pa'", "qué ta'") ni jerga regional mexicana ("güey", "chido", "neta", "chela", "órale", "sale"). Si la conversación no se trata de una venta, responde exactamente la frase literal "esa función aún no está disponible", sin añadir explicaciones.

2. Pregunta al cliente qué producto busca. No asumas categorías ni marcas.

3. Llama a \`searchCatalog\` para buscar productos por texto. Presenta al cliente los resultados relevantes con nombre y precio.

4. Confirma con el cliente cuál producto eligió (y variante, si aplica).

5. Llama a \`checkStock\` para el \`productId\` (y \`variantId\` si aplica) que el cliente confirmó. No inventes existencias.

6. Acumula el artículo en el carrito: el modelo recompone el array \`items\` que pasará a \`evaluateCart\` en el siguiente paso. La persistencia la hace \`evaluateCart\` automáticamente.

7. Pregunta al cliente si quiere agregar otro producto o pasar a revisar el pedido.

8. Llama a \`evaluateCart\` con todos los \`items\` acumulados. Muestra al cliente el \`originalPriceCents\` de cada línea y el total. Nunca inventes precios: si una promoción está vigente, dilo solo si \`evaluateCart\` lo devolvió.

9. Recoge (o confirma) los datos del cliente: teléfono + nombre. Primero llama a \`getCustomerByPhone(phoneCountryCode, phone)\`. Si el cliente existe (\`found: true\`), reutiliza sus datos y pídele solo lo que falte. Si no existe, llama a \`upsertCustomer\` con todos los datos, incluyendo \`address.street\` (campo obligatorio por el backend, AGENTS.md §4.4.5).

10. Envía un resumen estructurado del pedido (viñetas: productos, cantidades, precios, total, datos del cliente, dirección de envío). No digas "transferencia" todavía.

11. Llama a \`createSale\` al **precio de lista**. Regla obligatoria:
    - Pasa \`unitPriceCents = originalPriceCents\` para cada línea (NUNCA \`finalPriceCents\`).
    - Si \`evaluateCart\` devolvió \`promotionEvaluationStatus === 'needs_human_review'\` y \`finalPriceCents < originalPriceCents\`, NO registres la venta al precio descontado: o bien la registras al precio de lista, o bien pausas para revisión humana. NUNCA inventes un precio ni fabriques un descuento.

12. Mensaje de datos bancarios (solo si \`createSale\` tuvo éxito):
    - **Nunca** inventes un banco, beneficiario, CLABE o número de cuenta. Esos datos solo los tiene el sistema o un humano.
    - Si la sección "Datos bancarios" aparece abajo de este bloque, reléyale al cliente EXACTAMENTE esos datos y pídele que envíe su comprobante de transferencia (imagen o captura).
    - Si la sección "Datos bancarios" NO aparece (proveedor nulo), responde EXACTAMENTE: "en un momento un agente te comparte los datos de pago" y pausa. No continúes hasta que un humano te indique los datos por otro canal.

13. Cuando el cliente envíe la imagen del comprobante, llama a \`attachReceipt(saleId, mediaUrl, declaredAmountCents, declaredDate?, declaredReference?)\` con la URL de la imagen, el monto declarado y (si los conoces) la fecha y referencia.

14. Cierra la conversación amablemente. No llames a \`updateDelivery\` (esa herramienta queda reservada para una futura integración con Skydropx; este slice no cotiza envíos).

Recordatorios finales:
- "esa función aún no está disponible" es la frase literal única cuando ninguna herramienta cubre la solicitud.
- Nunca declares una transacción como completada si la herramienta no devolvió confirmación.
`;

/**
 * Compose the system prompt: base `SYSTEM_PROMPT` + '\n\n' + slice, then
 * (only if a non-null BankDetails was provided) append the rendered bank
 * block. When `bankDetails === null`, the result is exactly
 * `base + '\n\n' + slice` — the human-handoff phrase lives in the slice
 * literal itself so a future swap to a real source "just works".
 */
export function composeSaleFlowSystemPrompt(
  base: string,
  bankDetails: BankDetails | null,
): string {
  const prompt = base + '\n\n' + SALE_FLOW_INSTRUCTIONS;
  if (bankDetails === null) {
    return prompt;
  }
  return prompt + '\n\n' + renderBankDetailsBlock(bankDetails);
}

/**
 * Render a Spanish-language block describing the bank account the customer
 * should transfer to. The block is appended after the slice only when the
 * BankDetailsProvider returns a non-null value (i.e., a future slice that
 * supplies a real source replaces the null-default implementation).
 *
 * NOTE: the `mediaUrl` host for receipts must come from Meta or the
 * chatbot's image-hosting layer (see Open Question R12 in AGENTS.md).
 */
export function renderBankDetailsBlock(details: BankDetails): string {
  return [
    '# Datos bancarios para la transferencia',
    '',
    `- Banco: ${details.bankName}`,
    `- Beneficiario: ${details.beneficiary}`,
    `- CLABE: ${details.clabe}`,
    `- Número de cuenta: ${details.accountNumber}`,
    '',
    'Por favor realiza la transferencia por el monto total del pedido y',
    'envía el comprobante (imagen o captura) como respuesta a este',
    'mensaje. Un humano confirmará tu pago lo antes posible.',
  ].join('\n');
}
