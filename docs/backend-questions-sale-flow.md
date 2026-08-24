# Preguntas al equipo del backend — Sale Flow del WhatsApp Chatbot

> Documento de coordinación entre `houndfe-chatbot` y `houndfe-backend`.
> Autor: Fabian (dev del bot) → destinatario: equipo del backend de HoundFe.
> Fecha: 2026-08-24. Estado: **pendiente de respuesta**.

---

## Contexto

Estamos construyendo el **flujo de venta conversacional** del bot de WhatsApp: el cliente busca
productos, arma un carrito, da sus datos, confirma la orden, y paga por **transferencia**
(mandando el comprobante, que un humano confirma después).

El bot consume la chatbot-api del backend (9 endpoints documentados en `AGENTS.md` §4). Ya
auditamos endpoint por endpoint contra el código del backend (solo lectura). **La mayoría está
implementada**, pero hay **3 gaps que bloquean el flujo completo** y varios puntos a confirmar.

**Decisiones ya tomadas para este slice (no requieren respuesta):**

- El envío (cotización Skydropx, crédito $120, zonas gratis CDMX) queda **fuera de este slice** — es
  un slice futuro. Pero lo dejamos anotado como dependencia para que el diseño del bot no lo
  contradiga.
- El bot es **solo transferencia** en v1. Tarjeta (Link EVO, R16) queda para un slice futuro.
- El backend es la fuente de verdad: el bot jamás escribe directo a la DB.

---

## Bloqueantes (respuesta necesaria para cerrar este slice)

### Q1. Datos bancarios para el mensaje de transferencia (R11)

**Contexto:** En el flujo real, después de confirmar la orden el bot manda un mensaje con los datos
bancarios (AFIRME, HUN F.E. COMERCIALIZADORA SA DE CV, CLABE + número de cuenta) y pide el
comprobante. Hicimos grep de `clabe|afirme|bank|cuenta|iban|accountNumber|bankName` en todo el
backend y **no existe ninguna fuente** de estos datos: ni tabla, ni config, ni endpoint.

**Pregunta:**
¿Dónde debe vivir esa data y cómo la expone el backend para que el bot la consuma?
Opciones que consideramos:
- (a) Un endpoint nuevo de chatbot-api (p. ej. `GET /chatbot-api/company/payment-details`) con scope
  `catalog:read` o uno nuevo, que devuelva `{ bankName, beneficiary, clabe, accountNumber }`.
  Es lo más limpio: el bot no hardcodea datos sensibles.
- (b) Una tabla `PaymentDetail` por tenant/sucursal (puede haber más de una cuenta).
- (c) Config del backend (env/seed) expuesta por el endpoint (a).

**Qué necesitamos saber:** módulo/tabla/endpoint propuesto, scope requerido, y si es por sucursal
(tenant) o global.

---

### Q2. Venta con precio de promoción (R13) — `POST /chatbot-api/sales`

**Contexto:** El bot cotiza con `POST /chatbot-api/pricing/evaluate-cart`, que devuelve
`finalPriceCents` con descuentos aplicados (promos `PRODUCT_DISCOUNT`). Pero al registrar la venta,
`confirmBotSale` (en `sales/sales.service.ts`) valida que `unitPriceCents` sea igual al precio
**de lista** vigente (`getApplicablePrices` → si no coincide lanza `PRICE_OUT_OF_DATE`) y escribe
`discountCents = 0` fijo.

**Consecuencia:** si el bot manda el precio con descuento que cotizó, el backend rechaza la venta.
Hoy no hay forma de registrar una venta con descuento de promoción por API.

**Pregunta:**
¿Cómo habilitamos que `POST /chatbot-api/sales` registre la venta al precio final evaluado?
Opciones:
- (a) Aceptar `discountCents` (o `promoPriceCents`) en el DTO de venta, validando que el total
  coincida con una evaluación de `evaluate-cart` reciente (idempotente contra manipulación).
- (b) Un flag `pricingEvaluationId` o token: el bot manda el resultado de `evaluate-cart` y el
  backend lo valida.
- (c) Aceptar `unitPriceCents` fuera de lista **solo** si hay una evaluación de carrito que lo
  respalde, y persistir `discountCents` real (para reportes).

**Qué necesitamos saber:** cuál opción implementan (o si proponen otra), qué campos nuevos entran al
DTO/contrato, y qué validaciones de seguridad ponen (evitar que el bot mande precios inventados).

---

### Q3. Race condition en la idempotencia de venta

**Contexto:** `registerBotSale` reserva el slot de `SaleIdempotency` **fuera** de la transacción de
la venta y no corta en `IN_FLIGHT` ni detecta conflicto de key. Dos requests concurrentes con la
misma `X-Idempotency-Key`, o un crash entre `confirmBotSale` y `markSucceeded`, pueden crear
**ventas duplicadas**.

**Pregunta:**
¿Endurecen el flujo de idempotencia (acquire → IN_FLIGHT → replay/conflict → SUCCEEDED/FAILED)
como el de POS charge? Es un fix del backend; el bot solo manda la key.

---

### Q4. Usuario cajero del bot + ServiceCredential

**Contexto:** `POST /chatbot-api/sales` requiere `cashierUserId` (FK a `User.id`) y la auth requiere
una ServiceCredential con scopes. En el audit no vimos si ya se seedearon.

**Pregunta (dos partes):**
1. ¿Ya existe seedeado un `User` dedicado para el bot? Si no, ¿qué `userId` debe usar el bot y de
   dónde lo lee (p. ej. un env `CHATBOT_API_CASHIER_USER_ID`)?
2. ¿La ServiceCredential de la sucursal ya está creada con scopes `catalog:read`,
   `pricing:evaluate`, `customers:read`, `customers:write`, `sales:create`, `sales:write`?
   ¿Cuál es el `X-Branch-Id` (tenantId) que debe mandar el bot?

---

## A confirmar (no bloquean, pero definen el contrato)

### Q5. Cobertura de `evaluate-cart`

**Contexto:** `evaluate-cart` hoy solo aplica promos `PRODUCT_DISCOUNT` con target directo por
`productId`. Ignora variantes, categorías, marcas, buy-x-get-y, descuentos por orden, tiers,
día-de-semana y price lists. Además, si existe **cualquier** promo activa no soportada (aunque no
aplique al carrito), devuelve `needs_human_review` — lo que hace que el bot derive a humano de más.

**Pregunta:** ¿Esa cobertura reducida es aceptable para v1 del bot (y afinamos el criterio de
`needs_human_review` para que solo aplique cuando la promo sí afecta al carrito), o reusan el motor
de promos completo del POS?

### Q6. DTO de upsert de cliente

**Contexto:** `PUT /chatbot-api/customers/by-phone` exige `address` completo con `street`
obligatorio (`@ValidateNested`, sin `@IsOptional`). En el flujo real, el bot a veces necesita
guardar primero solo nombre + teléfono y completar dirección después (o la dirección llega en un
mensaje aparte).

**Pregunta:** ¿Relajan el DTO para permitir perfil parcial (`address` opcional, y dentro de él
`street` opcional hasta completar)? El bot puede mandar el perfil en dos pasos.

### Q7. Validación de `phoneCountryCode` en order-history

**Contexto:** `GET /chatbot-api/customers/by-phone/:phone/orders` lee `phoneCountryCode` como
`@Query()` crudo sin DTO (si falta, queda `''`). El bot siempre lo manda, pero el contrato no lo
valida.

**Pregunta:** ¿Le agregan un DTO de validación (como el resto de los endpoints) para que el contrato
sea consistente?

---

## No urgentes (futuros slices — solo registro)

- **Envío / cotización (R2–R5):** no hay cliente Skydropx, config de carrier ni modelo de costo de
  envío en el backend. El slice de shipping del bot necesitará decidir si el bot llama a Skydropx
  directo o si el backend construye un endpoint de cotización. Regla de crédito $120/artículo >$500
  y lista de zonas gratis CDMX aún pendiente del owner.
- **Tarjeta Link EVO (R16):** backend soporta `CARD_CREDIT`/`CARD_DEBIT` como métodos, pero no hay
  integración con Link EVO. Queda para un slice futuro.
- **Endpoint extra encontrado:** existe `POST /chatbot-api/sales/:saleId/cancel` en el backend que
  **no está documentado** en AGENTS.md §4.5 ni en el cliente del bot. ¿Es intencional o quedó de
  otro cambio? (No lo vamos a usar en este slice.)
