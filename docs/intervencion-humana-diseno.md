# Intervención humana dentro del sistema — diseño

Todo lo que el bot de WhatsApp necesita que resuelva una persona de HoundFe se convierte en una **solicitud dentro del sistema**. La persona la recibe por aviso en el sistema y por correo, la atiende ahí, y el bot le transmite la respuesta al cliente. Este canal reemplaza al canal de WhatsApp de operaciones (`OPS_CHANNEL_PHONE`).

Decidido con el dueño el 2026-11-09, en cinco bloques. Cada regla viene de una respuesta explícita suya.

**Por qué:** WhatsApp cobra por mensaje (los avisos salientes a operaciones necesitan plantillas pagadas fuera de la ventana de 24 h) y todo queda dentro del ecosistema: registro, permisos, auditoría y varias personas atendiendo.

## 1. Escenarios

Hay tres tipos de solicitud. Cada uno se resuelve de forma distinta:

- **Decisión**: opciones cerradas (sí/no, una fecha, un porcentaje). Se resuelve con botones y el bot responde con texto fijo.
- **Aclaración**: una pregunta abierta. La persona escribe la respuesta y el bot la transmite **tal cual**.
- **Conversación**: el cliente habla con una persona en vivo desde el sistema y el bot se calla mientras tanto.

| Escenario                                   | Tipo                                       | Estado hoy               | En este diseño           |
| ------------------------------------------- | ------------------------------------------ | ------------------------ | ------------------------ |
| Producto sin stock (cuándo llega, reservar) | Decisión                                   | Solicitud en el backend  | Entra a la bandeja común |
| Pregunta de caducidad                       | Decisión                                   | Solicitud en el backend  | Entra a la bandeja común |
| Código postal sin zona conocida             | Decisión                                   | Aprobación en el backend | Entra a la bandeja común |
| Comprobante de transferencia                | Decisión                                   | Revisión en el backend   | Entra a la bandeja común |
| "Quiero hablar con una persona"             | Conversación                               | WhatsApp de operaciones  | **Nuevo**                |
| Queja, devolución o producto dañado         | Conversación                               | No existe                | **Nuevo**                |
| Pregunta que el bot no sabe responder       | Aclaración                                 | No existe                | **Nuevo**                |
| El cliente pide un descuento                | Decisión (aprobar, rechazar, contraoferta) | No existe                | **Nuevo, segunda etapa** |

**Fuera de esta versión:** cancelar o cambiar un pedido ya creado; estado o retraso de un pedido (hoy no hay una fuente confiable); mayoreo; pago parcial con el resto al recibir (idea: política por cliente basada en `isTrusted`).

**Precio especial por cliente:** no necesita campos nuevos. Se asigna al cliente su **lista de precios** en el POS y el bot ya cotiza con ella, porque `evaluate-cart` recibe el teléfono del cliente y el backend aplica su lista.

## 2. Cómo lo ve el personal

### Bandeja "Chatbot → Solicitudes"

Una sola lista con todos los tipos, **agrupada por cliente**. Cada fila muestra el tipo, el cliente (nombre y teléfono), un resumen de una línea escrito por el bot, la antigüedad y el tiempo restante (verde, amarillo, rojo), el estado y quién la atiende.

**Estados:** Nueva → En atención (por X) → Resuelta. Además: **Vencida** (pasó el tiempo límite; sigue abierta y se puede responder) y **Cancelada** (el cliente desistió o se resolvió solo).

### Quién atiende

- **Una sola persona a la vez.** Con "Atender" la solicitud queda a su nombre. Los demás, si tienen permiso, la ven en solo lectura, con la leyenda "La está atendiendo Juan".
- "Liberar" la devuelve a Nueva.
- Quien tenga el permiso de **reasignar** puede pasársela a otra persona.
- No hay roles fijos: cada acción es un **permiso granular** (ver, atender, reasignar, ver historial de conversación, recibir escalamientos).

### Detalle de una solicitud

1. **Ficha del cliente:** nombre, teléfono, desde cuándo es cliente, últimos pedidos, si es de confianza y su lista de precios.
2. **Conversación con el bot,** incluidas las fotos que mandó el cliente. Requiere el permiso de ver historial.
3. **Contexto del momento:** carrito o pedido en curso.
4. **Qué se necesita,** en claro.
5. **Otras solicitudes abiertas del mismo cliente,** que se pueden resolver desde ahí.
6. **Panel de acción según el tipo:**
   - Decisión: botones cerrados.
   - Aclaración: cuadro de texto. El bot la manda tal cual, con esta frase antes: "Le comparto la respuesta del equipo: …".
   - Conversación: chat en vivo. Los mensajes salen por el número del bot. Al tomarla, el cliente recibe "Le atiende <nombre> del equipo HoundFe". Se cierra con **"Finalizar y devolver al bot"** más una nota, y el cliente recibe un aviso de que vuelve a hablar con el bot.
   - Queja: igual que la conversación, más una clasificación al cerrar (devolución, reposición, reembolso, sin acción).

## 3. Notificaciones

Es **un módulo común del backend** que usan todas las solicitudes y que sirve también para otros eventos del sistema más adelante. **Avisar nunca bloquea la creación de la solicitud:** primero se crea la solicitud y después sale el aviso (outbox con reintentos; las fallas quedan registradas).

| Evento                                  | A quién                      | En el sistema      | Correo            |
| --------------------------------------- | ---------------------------- | ------------------ | ----------------- |
| Solicitud nueva                         | Todos con permiso de atender | Sí                 | Sí                |
| Nadie la tomó a mitad del tiempo límite | Todos con permiso de atender | Sí                 | Sí (recordatorio) |
| Está por vencer sin tomar               | Con permiso de escalamiento  | Sí                 | Sí                |
| Venció                                  | Con permiso de escalamiento  | Sí                 | Sí                |
| El cliente escribió en mi conversación  | Solo quien atiende           | Sí, en tiempo real | No                |
| Me reasignaron una solicitud            | La persona nueva             | Sí                 | Sí                |
| El cliente canceló o se resolvió solo   | Quien la atendía             | Sí                 | No                |

- **En el sistema:** campana con contador y lista, en tiempo real (sin recargar) y notificación del navegador con sonido opcional cuando la pestaña no está a la vista.
- **Correo:** con **Resend**, que ya está configurado en el backend. Asunto claro ("[HoundFe] Nueva solicitud: pregunta de Juan Pérez"), resumen de una línea, botón "Abrir solicitud" y **ningún dato sensible**.
- Cada persona puede apagar los correos desde su perfil. Los avisos del sistema no se pueden apagar.

## 4. Tiempos y fallas

### Mientras el cliente espera

- El bot avisa una vez: "Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan".
- **El bot sigue ayudando con otras cosas** (buscar productos, armar el carrito). Esto reemplaza el comportamiento actual, que contesta "Seguimos esperando la respuesta del equipo…" a cualquier mensaje.
- Si el cliente dice "ya no" o "ya lo resolví", la solicitud pasa a **Cancelada** y se avisa a quien la atendía.
- **Excepción:** durante una conversación en vivo el bot no responde nada.

### Tiempos límite (iniciales, configurables en el sistema)

| Tipo                        | Para tomarla | Para resolverla |
| --------------------------- | ------------ | --------------- |
| Conversación                | 10 min       | En vivo         |
| Queja                       | 30 min       | 4 h             |
| Pregunta que el bot no sabe | 30 min       | 2 h             |
| Descuento                   | 30 min       | 2 h             |
| Stock / caducidad           | 1 h          | 4 h             |
| Zona de entrega             | 1 h          | 4 h             |
| Comprobante                 | —            | Mismo día hábil |

### Horario de atención

- **Un horario genérico para todas las sucursales,** configurable. Valor inicial propuesto: lunes a sábado de 9 a 19 h.
- Fuera de horario el bot igual crea la solicitud y avisa: "Nuestro equipo atiende de lunes a sábado de 9 a 19 h. Le respondemos en cuanto abramos".
- **El reloj de los tiempos límite se pausa fuera de horario.**

### Vencimiento

Siguen los recordatorios y escalamientos de la sección 3. El bot le avisa al cliente **una sola vez**: "Todavía no tengo respuesta del equipo; sigue pendiente y le aviso en cuanto la tenga". La solicitud sigue abierta.

### Ventana de 24 h de WhatsApp

Si la respuesta llega más de 24 h después del último mensaje del cliente, ya no se le puede escribir gratis.

- **Quejas, descuentos y conversaciones:** se manda **una plantilla pagada** aprobada por Meta ("Tenemos respuesta a su consulta, escríbanos para verla") y la respuesta se entrega cuando el cliente contesta.
- **El resto:** la respuesta queda guardada y se entrega cuando el cliente vuelva a escribir.
- El sistema **marca las solicitudes cuya ventana está por cerrarse** para priorizarlas.

### Conversación en vivo colgada

| Situación                                                | Qué pasa                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| El cliente escribió y quien atiende no contesta en 5 min | Aviso insistente a quien atiende                                  |
| … y a los 15 min                                         | Aviso a quienes tienen permiso de reasignar                       |
| El cliente no contesta hace 30 min                       | Quien atiende puede finalizar                                     |
| … y a las 2 h                                            | Vuelve sola al bot y se avisa al cliente                          |
| Quien atiende se fue                                     | La conversación sigue a su nombre; se usa el permiso de reasignar |

### Fallas técnicas

- **El backend no responde al crear la solicitud:** el bot reintenta en segundo plano y nunca promete algo que no quedó registrado.
- **El bot está caído cuando el equipo responde:** la respuesta queda guardada en el backend y el bot la entrega cuando vuelve.
- **Entrega dudosa:** cada respuesta lleva un identificador único, así que el cliente nunca la recibe dos veces.

## 5. Reglas comunes

1. **Varias solicitudes por cliente:** se agrupan por cliente. Una pregunta repetida se suma a la solicitud que ya existe, no crea otra.
2. **El bot no inventa lo que decide una persona:** no promete fechas, descuentos, devoluciones ni respuestas técnicas. Sin datos del sistema, crea la solicitud.
3. **Auditoría completa:** quién tomó, respondió, reasignó o canceló, y cuándo. Lo enviado al cliente no se edita; una corrección es un mensaje nuevo.
4. **Una bandeja para todo:** stock, caducidad, zona y comprobantes conservan su lógica en el backend, envuelta en un modelo común de solicitud con los mismos estados, avisos y tiempos.
5. **Pertenencia:** la solicitud se vincula al cliente del backend si existe; si no, al teléfono, y se asocia cuando el cliente se registra.
6. **Privacidad:** la conversación con el bot se replica en el backend y se guarda **12 meses**; después se borra automáticamente.
7. **Fuera de esta versión:** que el personal inicie conversaciones por su cuenta, y el tablero de métricas (los datos se guardan desde el primer día).
8. **Cierre:** cuando todo funcione, se retiran el canal de WhatsApp de operaciones y `OPS_CHANNEL_PHONE`.

## 6. Reparto del trabajo

Cada sesión trabaja en su repositorio, en paralelo. El contrato entre chatbot y backend se acuerda **antes** de que nadie implemente.

### Backend (`houndfe-backend`)

- Modelo común de **solicitud** (tipo, estado, cliente o teléfono, asignado, tiempos, ventana de 24 h) que envuelve a stock, caducidad, zona y comprobantes.
- Permisos granulares: ver, atender, reasignar, ver historial, recibir escalamientos.
- **Módulo de notificaciones:** en el sistema (tiempo real) y correo con Resend, outbox con reintentos y preferencia de correo por persona.
- Tiempos límite y horario configurables, con reloj que se pausa fuera de horario; recordatorios, escalamientos y vencimientos.
- Réplica de la conversación del bot con retención de 12 meses.
- API para el chatbot: crear solicitud, consultar o recibir respuestas, mensajes en vivo, estado de conversación (tomada o devuelta) y cancelación por el cliente.
- Auditoría.

### Frontend (`frontend-houndfe`)

- Bandeja "Solicitudes" agrupada por cliente, con estados, colores de tiempo y asignado.
- Detalle con ficha del cliente, historial y contexto, y panel de acción por tipo.
- Chat en vivo con "Finalizar y devolver al bot" y clasificación de quejas.
- Campana de notificaciones en tiempo real, notificación del navegador con sonido, y preferencia de correo en el perfil.
- Configuración de tiempos límite y horario.

### Chatbot (`houndfe-chatbot`)

- Detectar los escenarios nuevos (hablar con una persona, queja, pregunta sin respuesta, descuento) y crear la solicitud. Nunca prometer por su cuenta.
- Seguir ayudando mientras hay solicitudes pendientes y entender cuando el cliente desiste.
- Entregar respuestas tal cual, sin duplicar y respetando la ventana de 24 h (plantilla solo para quejas, descuentos y conversaciones).
- Modo conversación: callarse, reenviar los mensajes del cliente al sistema y los del personal al cliente, con los avisos de inicio y fin.
- Replicar la conversación en el backend.
- Al final, retirar `OPS_CHANNEL_PHONE` y el canal de WhatsApp de operaciones.

### Propuestas de cada repositorio

- Backend: `houndfe-backend/docs/proposals/human-intervention-backend-proposal.md` (rama `docs/human-intervention-proposal`).
- Frontend: `frontend-houndfe/docs/redesign/human-intervention-frontend-proposal.md`.

### Orden sugerido

1. Contrato chatbot ↔ backend y modelo común de solicitud.
2. En paralelo: notificaciones (backend), bandeja y campana (frontend), creación de solicitudes y bot que no se bloquea (chatbot).
3. Aclaraciones y conversación en vivo, de punta a punta.
4. Quejas.
5. Descuentos (segunda etapa).
6. Retiro del canal de WhatsApp de operaciones.
7. Agenda de conversaciones fuera de horario (al final, cuando la cola, las respuestas y la conversación en vivo estén probadas).

## 7. Decisiones del dueño posteriores a las propuestas (2026-11-09)

Estas decisiones salieron después de leer las propuestas del backend y del frontend. Donde contradicen algo de las secciones anteriores, mandan estas.

**Tomadas directamente con la sesión del backend:**

- **Horario por sucursal,** con una acción "aplicar a todas" para quien tenga el permiso. Cada sucursal es un tenant aparte, así que no existe un horario global. Esto reemplaza al "horario genérico" de la sección 4.
- **El bot se calla solo cuando una persona toma la conversación,** no cuando el cliente pide hablar con alguien.
- **Fuera de horario, "quiero hablar con una persona" se agenda.** El bot da el horario y ofrece programar la atención, y la conversación queda agendada en el sistema (propuesta del backend, §4.9).
- **A los 12 meses se borra solo la conversación** (mensajes y medios). Las solicitudes y la auditoría se conservan.

**Correos:**

- **Sin nombre ni teléfono del cliente:** solo tipo, sucursal y folio. El correo trae un **link que abre directo la solicitud** en el sistema, sin buscarla.
- **Los avisos de "solicitud nueva" se juntan en un correo cada 2 minutos.** Las conversaciones en vivo son la excepción: su correo sale solo e inmediato.

**Agenda:**

- **Bloques de 30 minutos.** Se ofrecen 3 horarios: la próxima apertura y 2 más.
- **Tope de 3 conversaciones por bloque y sucursal,** configurable desde el sistema.
- **Primero se ofrecen los horarios dentro de la ventana gratis de 24 h.** Si no hay ninguno, se acepta igual con plantilla pagada.
- **Feriados:** se cargan como días cerrados en la configuración y se pueden cambiar en cualquier momento. Todavía no hay fechas fijas.

**Personal:**

- **Ver el teléfono completo requiere un permiso aparte.** Sin él se ve parcial (`55 **** 5678`).
- **El personal puede mandar fotos o PDF** en la conversación.
- **Los audios del cliente se guardan** para escucharlos en la bandeja: tope de 10 MB, se borran a los 12 meses con la conversación. Si llega un audio y no hay una persona atendiendo, el bot le pide al cliente que lo escriba.
- **El sonido viene activado por defecto** y cada persona lo puede apagar.

**Reglas:**

- **Aprobar una zona resuelve a la vez las solicitudes de todos los clientes** que preguntaron por ese código postal.
- **Un comprobante que llega cerca del cierre o en día cerrado vence al cierre del siguiente día hábil.**
- **Las solicitudes resueltas quedan 7 días en la bandeja** y después pasan a un historial aparte.
- **La plantilla pagada la manda la persona que atiende, con un botón.** El sistema no la manda solo. El texto se redacta y lo aprueba Meta; depende del número real, porque las plantillas se aprueban por cuenta de WhatsApp.
- **La clasificación de quejas** (devolución, reposición, reembolso, sin acción) **solo se registra.**
- **Se retira la cola de validación de zonas de "Sistema"** cuando la bandeja común esté lista.

## 8. Segunda versión — no perder

Todo lo que quedó "para después". Pidió el dueño que quede anotado porque se va a retomar.

| Tema | Qué quedó pendiente | Origen |
|---|---|---|
| Descuentos | Solicitud de descuento con aprobar, rechazar o contraoferta. Está en el diseño, pero se construye en una segunda etapa. | Bloque 1 |
| Pago parcial | Política por cliente para pagar una parte y el resto al recibir (idea: basada en `isTrusted`, con porcentaje y tope de deuda). | Bloque 1 |
| Cancelar o cambiar un pedido | El cliente cancela o modifica un pedido ya creado. | Bloque 1 |
| Estado o retraso de un pedido | Hoy no hay una fuente confiable de seguimiento. | Bloque 1 |
| Mayoreo | Pedidos grandes con precio especial o stock de varias sucursales. Probablemente no se integre. | Bloque 1 |
| Quejas que disparan acciones | Que "reembolso" o "reposición" generen una tarea, un aviso o un movimiento, en vez de solo registrarse. | Pregunta 16 |
| Respuestas rápidas | Frases guardadas para responder aclaraciones repetidas. | Pregunta 10 |
| Transcripción de audios | El bot transcribe los audios con IA y sigue la conversación, en vez de pedir que los escriban. Medir antes cuántos audios llegan. | Pregunta 9 |
| Conversaciones iniciadas por el personal | Que el personal le escriba a un cliente por su cuenta (requiere plantillas pagadas fuera de las 24 h). | Bloque 5 |
| Tablero de métricas | Tiempos de respuesta, volumen por tipo y cuántas vencieron. Los datos se guardan desde el primer día. | Bloque 5 |
