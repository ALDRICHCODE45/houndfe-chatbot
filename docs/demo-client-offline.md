# Demo offline para el cliente — Decisiones humanas (RESTOCK)

Recorrido **sin servicios en vivo** por la evidencia ya probada de este
repositorio: solo comandos locales y un tablero HTML autocontenido.

- Alcance: un caso RESTOCK offline y la ingeniería que lo respalda.
- No es: integración de extremo a extremo ni demostración de producto real.
- Regla de oro: en la demo **no** se envía nada a un asesor ni a un cliente. La
  POST es **falsa** y solo simula la admisión (_intake_).

## Leyenda de estado (usar en toda la charla)

| Etiqueta                        | Significado en esta demo                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- |
| **IMPLEMENTED OFFLINE**         | Código del bot probado en este repositorio, sin red ni backend real.          |
| **SIMULATION**                  | Ruta con cliente/backend _falso_ y base **desechable** (Testcontainers).      |
| **PROBADO OFFLINE · OTRA RAMA** | Implementado y probado, pero en otra rama; **no** integrado aquí.             |
| **EVIDENCIA SEPARADA**          | Suites/ramas reportadas por otros equipos; se citan, **no** se ejecutan aquí. |
| **PLANNED**                     | Integración ausente: GET/ACK del bot, entrega al dispositivo, montaje del FE. |

`HUMAN_DECISIONS_RESTOCK_ENABLED` **por defecto es `false`**. Reserva, ledger y
coordinador existen y están probados; el coordinador **sí** compone reserva y
ledger, pero el preflight **no** está cableado al coordinador ni al webhook. La
demo usa un **evento sintético** (llamador de prueba).

## Guion de 5 minutos (300 s; narración en español)

1. **(30 s) Encuadre.** "Demostración guiada y offline: cómo el bot decide una
   solicitud de reposición y qué piezas están probadas. Sin prometer entrega."
2. **(60 s) La línea de decisión.** Un **evento sintético** (llamador de prueba,
   no un webhook) dispara **una** solicitud. Primero se **reserva** localmente;
   solo si la reserva autoriza se envía **una** POST **falsa** que simula la
   admisión; luego se registra el recibo.
3. **(50 s) Estados del ledger.** Recorrer `RESERVED → POST_IN_FLIGHT →
RECEIPT_RECORDED | UNKNOWN`. Un resultado ambiguo queda en **espera**, nunca
   como éxito inventado.
4. **(50 s) Bloqueos y esperas.** Mostrar `blocked` (entrada mal formada, ocupado,
   colisión, reserva bloqueada) y `hold` (`post_in_flight`, `unknown_hold`,
   `record_unconfirmed`). Todo es fail-closed.
5. **(50 s) Simulación honesta.** "El POST al backend es **falso**; la base es
   PostgreSQL **desechable** con Testcontainers (`postgres:16-alpine`). Prueba la
   ruta durable, no un backend real."
6. **(30 s) Segundo caso y evidencia.** Envío (otra rama): `SHIPPING_APPROVAL`
   (aprobar/rechazar/expirado), offline. Backend y frontend: **evidencia
   separada**, no ejecutada aquí.
7. **(30 s) Cierre.** "El preflight y el coordinador no están conectados entre sí
   ni al webhook. Todo está etiquetado; nada de esto es una integración viva."

## Preflight (antes de la reunión)

```bash
git branch --show-current        # esperado: feat/human-decisions-restock
git rev-parse --short HEAD       # anotar el commit que se mostrará
node -v && pnpm -v               # registrar el entorno
docker info >/dev/null 2>&1 && echo "DOCKER OK" || echo "SIN DOCKER — usar fallback"
```

No activar red, no fusionar ramas y no escribir fuera de este repositorio.

## Comando 1 — Coordinador RESTOCK (unit, sin Docker)

```bash
pnpm exec jest --runInBand --no-cache --runTestsByPath \
  src/human-decisions/application/restock-intake.service.spec.ts \
  src/human-decisions/application/restock-intake.service.adversarial.spec.ts
```

## Comando 2 — Especificaciones puras (ledger, reserva, preflight)

```bash
pnpm exec jest --runInBand --no-cache --runTestsByPath \
  src/human-decisions/domain/restock-post-ledger.spec.ts \
  src/human-decisions/domain/restock-post-ledger.adversarial.spec.ts \
  src/human-decisions/domain/shared-reservation.spec.ts \
  src/human-decisions/application/restock-request-preflight.spec.ts \
  src/human-decisions/application/restock-request-preflight.adversarial.spec.ts
```

## Comando 3 — Ruta durable (Docker, base desechable)

Solo con Docker. Usa un **cliente falso** (`submitRestockIntake`):

```bash
RUN_DOCKER_TESTS=1 pnpm exec jest --runInBand --no-cache --runTestsByPath \
  src/human-decisions/application/restock-intake.service.db.spec.ts \
  src/human-decisions/infrastructure/postgres-restock-post-ledger.store.transitions.db.spec.ts
```

Testcontainers levanta un contenedor **desechable**; **no** usa una base de datos
local persistente. **No** se ejecutan pruebas del backend ni del frontend.

## Alcance: qué prueba y qué no

Sí prueba: reserva, máquina de estados del ledger, recibo atómico y
esperas/bloqueos con cliente falso y base desechable. **No** prueba: entrega por
WhatsApp, backend real, pantallas del POS, ni unicidad de eventos entrantes (el
`sourceRequestId` lo provee el llamador; el preflight y el coordinador **no** están
cableados entre sí).

## Fallback sin Docker o sin navegador

- Sin Docker: omitir el **Comando 3** y declararlo "no ejecutado"; los Comandos 1
  y 2 no requieren contenedores.
- Sin navegador: mostrar el HTML por capturas; el guion no depende del navegador.
- Plan B: usar una grabación previa y decir que es una repetición. Registro:
  anotar commit, hora, comando exacto y resultado (aprobado/fallado/omitido). Si
  algo falla o se omite, decirlo. No fabricar conteos ni éxitos.

## Evidencia separada (reportada, no ejecutada aquí)

- **Backend `1188206` — EVIDENCIA SEPARADA:** HD-06 (handoff offline) **congelado
  por source bytes**, autorizado **solo para offline** (no activa el bot ni
  despliega). 20 suites DB-free / 1206 y 10 suites / 198 en base RESTOCK local
  dedicada (localhost, **no** desechable), build limpio. El Jest completo del
  backend sigue en rojo por fallos previos no relacionados (promociones/env);
  GET/ACK del bot siguen **no** conectados y default-off.
- **Frontend `88d0c81` — EVIDENCIA SEPARADA:** 11 suites / 219 pruebas de
  componentes. La ruta es un _shell_: **no** hay lista/detalle/resolver montados.
- **Shipping `116ce03` — PROBADO OFFLINE · OTRA RAMA:** **sí** implementa la
  resolución humana `SHIPPING_APPROVAL` (aprobar/rechazar/expirado) en una rama
  aparte, con cotización y aceptación del cliente codificadas; offline, con HTTP
  simulado (nunca llama al proveedor). Límites: `SHIPPING_QUOTES_ENABLED=false`,
  el ruteo SÍ/NO **no** está conectado al webhook y la resolución de colisión
  (`CANCEL_SHIPPING`/`CANCEL_RECEIPT`) **no** está implementada. Rama separada,
  **no** integrada con RESTOCK.

## Pendiente (PLANNED)

GET/ACK del bot, entrega al dispositivo, integración con RESTOCK y montaje de
lista/detalle/resolver en el frontend.

Archivos clave: `docs/demo-client-offline.html` ·
`src/human-decisions/application/restock-intake.service.ts` ·
`src/human-decisions/domain/restock-post-ledger.ts` · `docs/human-decisions-contract-v1.md`.
