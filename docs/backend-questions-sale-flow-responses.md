# Respuesta del backend — Sale Flow del WhatsApp Chatbot

> Documento de coordinación entre `houndfe-chatbot` y `houndfe-backend`.
> Autor: equipo del backend de HoundFe → destinatario: Fabian (dev del bot).
> Fecha: 2026-08-24. Estado: **respondido** (responde punto por punto a `docs/backend-questions-sale-flow.md`).
>
> Fuentes autoritativas: `openspec/specs/payment-details/spec.md`, `openspec/specs/chatbot-api-foundation/spec.md`,
> `openspec/specs/sales/spec.md` y `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` (actualizado a **11 endpoints**).
> El cambio `chatbot-sale-flow-blockers` quedó archivado en `openspec/changes/archive/2026-08-24-chatbot-sale-flow-blockers/`.

---

## Contexto

Los **3 bloqueantes** reportados quedaron implementados en el cambio `chatbot-sale-flow-blockers`:

| Bloqueante | Implementación |
| ---------- | -------------- |
| Q1 — Datos bancarios (R11) | Nueva tabla `PaymentDetail` + admin CRUD (`/admin/payment-details`) + endpoint bot `GET /chatbot-api/payment-details` |
| Q2 — Precio de promoción (R13) | Re-evaluación **server-side** del carrito con el motor completo de promos del POS + guard opcional `expectedTotalCents` (`409 PROMO_RE_QUOTE`) + `discountCents` en la respuesta |
| Q3 — Race de idempotencia | `registerBotSale` con el patrón atómico del POS (`acquire → replay / conflict / in_flight`), hash canónico de payload |

Las decisiones que ya estaban tomadas (envío/Skydropx y tarjeta Link EVO fuera de este slice, backend como fuente de verdad)
**se mantienen sin cambios** — ver §Aclaraciones al final.

---

## Bloqueantes (respondidos)

### Q1. Datos bancarios para el mensaje de transferencia (R11)

**Decisión:** se implementa la opción **(b) + (a)** combinada: una tabla `PaymentDetail` por tenant/sucursal (puede haber más de una cuenta) expuesta al bot por un endpoint nuevo de chatbot-api. **No** se usa config/env del backend.

**Contrato — modelo `PaymentDetail` (nuevo):**

| Campo | Tipo / regla |
| ----- | ------------ |
| `id` | UUID |
| `tenantId` | FK → `Tenant` (cascade on delete) — la cuenta vive en la sucursal |
| `bankName` | string, no vacío tras trim (p. ej. "AFIRME") |
| `beneficiary` | string, no vacío tras trim (p. ej. "HUN F.E. COMERCIALIZADORA SA DE CV") |
| `clabe` | **exactamente 18 dígitos** (`^\d{18}$`) |
| `accountNumber` | **≥ 10 dígitos** (`^\d+$`, `MinLength(10)`) |
| `isActive` | boolean, default `true` |
| `createdAt` / `updatedAt` | ISO 8601 (timestamps de auditoría) |

- **Unicidad**: `@@unique([tenantId, clabe])` — una sucursal no puede registrar la misma CLABE dos veces (`409 DUPLICATE_CLABE`); la **misma CLABE en otra sucursal SÍ es válida**.
- **Borrado**: solo **lógico** (`isActive=false`). No hay hard delete ni endpoint de reactivar: para activar una cuenta nueva se **crea un registro nuevo** (la desactivada queda como histórico de auditoría).
- **Múltiples cuentas por tenant permitidas**, con **exactamente una activa** como regla operacional (no forzada por la DB — ver endpoint del bot).

**Contrato — admin CRUD `POST/GET/PATCH/DELETE /admin/payment-details`** (guards `JwtAuthGuard + TenantContextGuard + PermissionsGuard`):

| Método | Ruta | Permiso CASL | Respuesta |
| ------ | ---- | ------------ | --------- |
| `POST` | `/admin/payment-details` | `create:PaymentDetail` | `201` con el registro creado |
| `GET` | `/admin/payment-details` | `read:PaymentDetail` | `200` con **todas** las cuentas (activas + inactivas), orden `updatedAt DESC` |
| `GET` | `/admin/payment-details/:id` | `read:PaymentDetail` | `200` detalle |
| `PATCH` | `/admin/payment-details/:id` | `update:PaymentDetail` | `200` registro actualizado (solo campos enviados) |
| `DELETE` | `/admin/payment-details/:id` | `delete:PaymentDetail` | `204` — baja lógica (`isActive=false`), sin body |

- Errores: `409 DUPLICATE_CLABE` (misma CLABE en el tenant), `404` para IDs inexistentes **o de otro tenant** (nunca `403`, no se filtra presencia), `400` por validación de DTO.
- Los 4 permisos se **auto-siembran** en el boot (`PermissionSeeder`, upsert idempotente) y se otorgan con el endpoint existente `PATCH /admin/roles/:id/permissions` (requiere `update:Role`), como cualquier otro permiso. El rol **Super Admin (`manage:all`) ya cubre** estos endpoints.

**Contrato — endpoint del bot (NUEVO):**

```
GET /chatbot-api/payment-details
Scope: payment-details:read        (override a nivel método del default catalog:read)
Auth:  ServiceCredential (Bearer svc_...) — el tenant sale del credential, no del bot
Audit: BotAuditInterceptor
```

**Response `200`** (proyección, SOLO la cuenta activa):
```json
{
  "id": "uuid",
  "bankName": "AFIRME",
  "beneficiary": "HUN F.E. COMERCIALIZADORA SA DE CV",
  "clabe": "012345678901234567",
  "accountNumber": "1234567890",
  "isActive": true,
  "updatedAt": "2026-08-24T12:00:00.000Z"
}
```
- Si hay **varias activas** (inconsistencia), devuelve la **más reciente** por `updatedAt DESC`.
- Si **no hay activa** → `404` con `error: "NO_ACTIVE_PAYMENT_DETAIL"` (envelope: `{ statusCode, error, message, timestamp }`).
- El response **no incluye** `tenantId` ni `createdAt` (proyección bot-safe).

**Acción del bot (requerida):**
1. Implementar el llamado a `GET /chatbot-api/payment-details` para renderizar el mensaje de transferencia de **R11** (banco, beneficiario, CLABE, cuenta) después de confirmar la orden.
2. Añadir el scope **`payment-details:read`** a la ServiceCredential (ver Q4).
3. Manejar `404 NO_ACTIVE_PAYMENT_DETAIL` como estado operacional (sucursal sin cuenta configurada → escalar/avisar, no reventar el flujo).
4. **Antes del go-live**: coordinar con el dueño del backend el seed/activación de **al menos un `PaymentDetail` por sucursal**.

---

### Q2. Venta con precio de promoción (R13) — `POST /chatbot-api/sales`

**Decisión:** se implementa la opción **(c) enderezada**: el bot manda el total que cotizó, pero el backend **re-evalúa el carrito server-side con el motor completo de promociones del POS** en el momento de confirmar (`recomputePricingAndPromotions` / `PosEvaluatePromotionsUseCase`), **no** con el `evaluate-cart` simplificado. El `discountCents` persistido es el resultado real del motor (subtotal − total), **nunca** un valor enviado por el bot.

**Qué cambió en el contrato de `POST /chatbot-api/sales` (scope `sales:create`, header `X-Idempotency-Key`):**

- **Nuevo campo OPCIONAL en el DTO**: `expectedTotalCents` (`@IsOptional @IsInt @Min(0)` — negativo → `400`). Es el total que el bot mostró al cliente (la suma de `finalPriceCents × quantity` de `evaluate-cart`).
- Si `expectedTotalCents` va y **no coincide** con el total recalculado por el motor → `409 PROMO_RE_QUOTE` con body:
  ```json
  {
    "statusCode": 409,
    "error": "PROMO_RE_QUOTE",
    "message": "…",
    "timestamp": "…",
    "recomputedTotalCents": 900,
    "expectedTotalCents": 1000,
    "discountCents": 100
  }
  ```
  y **sin efectos laterales**: no se persiste venta, no se descuenta stock, no se emite evento.
- `BotSaleResponse` ahora incluye **`discountCents`** (int): `0` cuando no aplica promo; `subtotalCents − totalCents` (real del motor) cuando aplica. Campos existentes intactos (aditivo).
- Fórmulas: `subtotalCents = Σ(originalPriceCents · qty)`; `totalCents = Σ(unitPriceCents · qty)` post-motor; `discountCents = subtotal − total ≥ 0`.
- El motor completo soporta `ORDER_DISCOUNT`, `BUY_X_GET_Y`, `ADVANCED`, reprice por tiers, scope por cliente, ventanas de fecha, `daysOfWeek` y price-list gating.
- **Se mantiene** `PRICE_OUT_OF_DATE` (`409`): `unitPriceCents` debe coincidir con el precio de lista vigente.

**Acción del bot (requerida):**
1. **Siempre** enviar `expectedTotalCents` = el total del `evaluate-cart` que se mostró al cliente.
2. Tratar `409 PROMO_RE_QUOTE` como **flujo normal, no error**: mostrar al cliente el nuevo total (`recomputedTotalCents`), re-cotizar y **re-emitir con una key nueva** (ver nota abajo).
3. Opcional: usar `discountCents` de la respuesta para el mensaje de confirmación.

> ⚠️ **Nota clave (derivada del contrato de Q3):** el `requestHash` de idempotencia **no incluye** `expectedTotalCents` y, si `confirmBotSale` falla tras adquirir el slot, este **queda `IN_FLIGHT`** (nunca se escribe `FAILED`). Por lo tanto, después de un `PROMO_RE_QUOTE` el bot **debe re-emitir con una `X-Idempotency-Key` NUEVA** (el payload cambió: nuevo total). Reusar la misma key daría `409 IDEMPOTENCY_KEY_IN_FLIGHT` (mismo hash, slot colgado). Regla general de Q3: **payload distinto → key nueva**.

---

### Q3. Race condition en la idempotencia de venta

**Decisión:** sí, se endureció el flujo. `registerBotSale` ahora usa el **patrón atómico del POS** (`create → P2002 → re-read`): el slot de `SaleIdempotency(tenantId, operation='bot_sale_register', key)` se adquiere **atómicamente antes de cualquier otra operación** y el servicio ramifica por estado.

**Contrato nuevo de idempotencia:**

- **Header `X-Idempotency-Key` obligatorio**. Validado **antes de cualquier DB read** (`ParseIdempotencyKeyPipe`): ausente, vacío (tras trim) o `> 200` caracteres → `400 INVALID_IDEMPOTENCY_KEY`.
- **Cuatro outcomes**:
  | Outcome | Condición | Resultado |
  | ------- | --------- | --------- |
  | `replay` | Slot `SUCCEEDED` + mismo hash + `responseJson` cacheado | Devuelve la **respuesta cacheada** (misma `saleId`, mismo folio, mismos totales); NO se vuelve a confirmar venta, no se descuenta stock, no se emite evento |
  | `conflict` | Slot existe pero el hash **no** coincide | `409 IDEMPOTENCY_KEY_CONFLICT` |
  | `in_flight` | Slot `IN_FLIGHT` + mismo hash | `409 IDEMPOTENCY_KEY_IN_FLIGHT` |
  | `acquired` | Slot nuevo reservado | Procede a `confirmBotSale` y luego estampa `SUCCEEDED` con el `responseJson` |
- **Hash de request**: `SHA-256(JSON.stringify(canonicalPayload))` sobre `{ cashierUserId, customerId, shippingAddressId, items }` con `items` ordenados asc por `(productId, variantId)`; cada item serializado como `{ productId, variantId, quantity, unitPriceCents }`. **Los nombres display (`productName`, `variantName`) quedan excluidos** → re-etiquetar productos NO rompe el replay.
- Namespace compartido entre credenciales del mismo tenant (aceptado para v1 single-bot-por-sucursal).
- El estado `FAILED` **nunca se escribe** (decisión D10): si `confirmBotSale` lanza tras `acquired`, el slot queda `IN_FLIGHT`; el siguiente acquire con la misma key devuelve `in_flight` (mismo hash) o `conflict` (hash distinto). Mitigación aceptada: limpieza manual.

**Acción del bot (requerida):**
1. **Generar una key aleatoria nueva por cada payload distinto** (carrito/cantidades/dirección/cajero diferentes).
2. **Reusar la MISMA key únicamente** para reintentar el payload **idéntico** (timeout/red/5xx).
3. **Nunca cambiar el payload bajo una key ya usada** (da `conflict`).
4. Ante `409 IDEMPOTENCY_KEY_IN_FLIGHT`: reintentar más tarde (el request original puede completar y pasar a `replay`).
5. Ante `409 IDEMPOTENCY_KEY_CONFLICT`: es un bug del cliente (key reusada con otro payload) → corregir con key nueva.
6. Ante `400 INVALID_IDEMPOTENCY_KEY`: validar key no vacía y ≤ 200 chars antes de mandar.

---

### Q4. Usuario cajero del bot + ServiceCredential

**Decisión:** **no están seedeados todavía**. El bot **no** debe hardcodear ningún `userId`; hay que aprovisionar antes del go-live. Lo único que cambió en este ciclo: la lista de scopes necesarios creció con `payment-details:read`.

**Qué se debe aprovisionar (responsabilidad del dueño del backend, coordinado con el equipo del bot):**

1. **(a) `User` dedicado del bot** — registro `User` real (FK de `Sale.userId → User.id`). Es el valor de `cashierUserId` en `POST /chatbot-api/sales`.
2. **(b) `ServiceCredential`** ligada al `tenantId` de la sucursal con scopes:
   ```
   catalog:read, pricing:evaluate, customers:read, customers:write,
   sales:create, sales:write, payment-details:read
   ```
   (el scope nuevo es `payment-details:read` para `GET /chatbot-api/payment-details`).

- **`X-Branch-Id` es opcional** (cross-check): si se envía y no coincide con `credential.tenantId` → `403`. El **tenant autoritativo es el del credential**, no el header.
- **No existe endpoint admin para crear ServiceCredentials**: se seedean directo en DB o con script de seed (mismo mecanismo que hoy).

**Acción del bot (requerida):**
1. Abrir la coordinación con el dueño del backend para la provisión (User + credential por sucursal) **antes del go-live**.
2. Leer `cashierUserId` desde config/env (p. ej. `CHATBOT_API_CASHIER_USER_ID`), **no** hardcodearlo.
3. Verificar que la credential incluye `payment-details:read` además de los 6 scopes previos.

---

## A confirmar (respondidos)

### Q5. Cobertura de `evaluate-cart`

**Decisión:** la cobertura reducida es **aceptada para v1 del bot**. `evaluate-cart` sigue soportando solo `PRODUCT_DISCOUNT` (target directo por `productId`). El afinamiento del criterio `needs_human_review` (que solo marque cuando la promo sí afecta al carrito) queda **diferido** — no se toca en este ciclo.

**Por qué no bloquea:** la **confirmación de venta re-evalúa con el motor completo** (Q2). Si en el momento de confirmar aplica una promo que `evaluate-cart` no soportaba, el motor la aplica y la venta devuelve `409 PROMO_RE_QUOTE` → el bot re-cotiza con el total real. Es el **flujo normal** de Q2, no un error.

**Acción del bot (requerida):**
1. Cuando `promotionEvaluationStatus === "needs_human_review"` en `evaluate-cart` → **derivar a humano** (como hoy).
2. Mandar **siempre** `expectedTotalCents` (Q2) para que el `PROMO_RE_QUOTE` proteja al cliente de un precio sorpresa y el bot re-cotice correctamente.

---

### Q6. DTO de upsert de cliente

**Decisión:** **NO cambia en este ciclo**. `PUT /chatbot-api/customers/by-phone` sigue exigiendo `address` completo con `street` obligatorio. La relajación a perfil parcial queda **diferida** a un slice futuro.

**Acción del bot:** el flujo actual del bot (recolectar dirección antes de confirmar) es compatible; mantener el envío del perfil completo en un solo request. Si algún paso necesita dirección después, queda registrado como dependencia del slice futuro.

---

### Q7. Validación de `phoneCountryCode` en order-history

**Decisión:** **NO cambia en este ciclo**. `GET /chatbot-api/customers/by-phone/:phone/orders` sigue leyendo `phoneCountryCode` como `@Query()` crudo (default `''` si falta). La adición del DTO de validación queda **diferida**.

**Acción del bot:** ninguna — el bot ya manda `phoneCountryCode` siempre; seguir haciéndolo (el contrato documentado en `PROGRAM-CONTEXT.md` §4.4.9 lo deja explícito).

---

## No urgentes (respondidos)

### Q8. Endpoint extra `POST /chatbot-api/sales/:saleId/cancel`

**Decisión:** **CONFIRMADO INTENCIONAL** — no quedó de otro cambio. El endpoint está **documentado ahora** en `PROGRAM-CONTEXT.md` §4.4.10 (era el endpoint faltante que hacía pasar el conteo de 9 a 10; con el nuevo `payment-details` de Q1 quedan **11 en total**).

**Contrato (no se usa en este slice, pero está disponible):**

```
POST /chatbot-api/sales/:saleId/cancel
Scope: sales:write
Body:  { "reason": "CUSTOMER_REQUEST" | "ORDER_ERROR" | "OUT_OF_STOCK" | "DUPLICATE_SALE" | "OTHER",
         "cashierUserId": "uuid" }
Response 200: la venta cancelada
```

- Idempotente vía **key derivada** `sale:cancel:<saleId>`.
- Mismo camino que la cancelación POS: **restockea**, construye reembolsos y emite `sale.canceled`.
- `cashierUserId` se registra como `canceledByUserId` (auditoría); **no** se exige que quien cancela sea el creador de la venta (cualquier actor autorizado del tenant puede cancelar).

**Acción del bot:** ninguna en este slice (no usar el endpoint). Queda disponible para un slice futuro (p. ej. cancelación conversacional).

### Aclaraciones sobre los futuros slices (registro, sin cambio)

- **Envío / cotización Skydropx** y **tarjeta Link EVO (R16)**: siguen siendo slices futuros; no hay integración backend nueva en este ciclo. Las reglas de crédito $120 y zonas gratis CDMX siguen pendientes del owner.
- **Conteo de endpoints**: `PROGRAM-CONTEXT.md` §4.5 quedó corregido de 9 a **11** (5 GET, 4 POST, 1 PUT, 1 PATCH) e incluye `payment-details:read` y `discountCents`.

---

## Cambios de contrato que requieren acción del bot

| Qué cambió | Detalle del contrato | Acción del bot | Prioridad |
| ---------- | -------------------- | -------------- | --------- |
| **Nuevo endpoint** `GET /chatbot-api/payment-details` + scope `payment-details:read` | Cuenta activa `{ id, bankName, beneficiary, clabe, accountNumber, isActive, updatedAt }`; `404 NO_ACTIVE_PAYMENT_DETAIL` si no hay activa | Implementar para R11 (mensaje de transferencia); añadir scope a la credential; coordinar seed de ≥1 cuenta por sucursal | 🔴 Alta (bloqueante para R11) |
| **`POST /chatbot-api/sales`**: `expectedTotalCents?` + `discountCents` en respuesta + `409 PROMO_RE_QUOTE` | Re-evaluación con motor completo del POS; error con `{ recomputedTotalCents, expectedTotalCents, discountCents }` y sin efectos laterales | Enviar **siempre** `expectedTotalCents` (total de `evaluate-cart`); ante `PROMO_RE_QUOTE`: mostrar nuevo precio y re-emitir **con key nueva** | 🔴 Alta (flujo normal de venta con promo) |
| **Idempotencia atómica** en `registerBotSale` | `400 INVALID_IDEMPOTENCY_KEY` (antes de DB read); `409 IDEMPOTENCY_KEY_CONFLICT`; `409 IDEMPOTENCY_KEY_IN_FLIGHT`; replay con respuesta cacheada; hash sin nombres display | Key **nueva por payload distinto**; misma key solo para reintentar payload idéntico; nunca mutar payload bajo una key; retry ante `in_flight` | 🔴 Alta (evita ventas duplicadas) |
| **Provisioning pendiente** (Q4) | `User` cajero dedicado + `ServiceCredential` con `payment-details:read` (además de los 6 scopes previos), ligada al tenant de la sucursal | Coordinar con el dueño del backend **antes del go-live**; leer `cashierUserId` de env, no hardcodear | 🔴 Alta (bloqueante para go-live) |
| **`evaluate-cart` cubre solo `PRODUCT_DISCOUNT`** (confirmado) | `needs_human_review` sigue sin afinarse (diferido) | Derivar a humano ante `needs_human_review`; las promos no soportadas en cotización se resuelven por `PROMO_RE_QUOTE` en confirmación | 🟡 Media |
| Q6 (perfil parcial de cliente) y Q7 (validación order-history) | Sin cambio en este ciclo (diferidos) | Ninguna | — |
| **Cancel documentado** (`POST /chatbot-api/sales/:saleId/cancel`) | Scope `sales:write`, idempotente con key derivada, restock + `sale.canceled` | No usar en este slice; queda disponible | 🟢 Baja |
