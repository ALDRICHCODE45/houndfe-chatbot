# Propuestas para un chatbot de primer nivel

Ideas priorizadas para que el bot de WhatsApp de Tienda de mascotas HoundFe venda más, se equivoque menos y se sienta humano. Cada propuesta indica el beneficio, el esfuerzo aproximado y si necesita al backend.

## Decisión del dueño (2026-11-07)

- **Empezar ya:** 2 (memoria del cliente), 3 ("lo mismo de la vez pasada"), 5 (foto del producto en la respuesta) y 6 (botones de WhatsApp).
- **Todas las demás se harán después, en orden.** No se descarta ninguna.

## Ya hecho en esta ronda

- **Personalidad de tienda de mascotas** y **espejo del estilo del cliente** (tú/usted, emojis, formalidad) en las respuestas de la IA y en los mensajes fijos.
- **Confirmaciones naturales**: "sí, por favor 🙏", "claro", "va", "ok" confirman; "no gracias" cancela con una respuesta clara; "sí, pero…" se trata como cambio.
- **Fotos de productos**: el bot reconoce la foto, busca en el catálogo, ofrece similares si no hay exacto y pide la etiqueta si no se entiende.
- **Evaluación de conversaciones**: 14 conversaciones de prueba con verificación automática de tono, trato, persona y pedidos duplicados (`pnpm eval:conversation`).

## Prioridad alta (siguientes 2 semanas)

| #   | Propuesta                                                                                                        | Beneficio                                                         | Esfuerzo | Backend                  |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- | ------------------------ |
| 1   | **Correr la evaluación con OpenAI real** antes de cada deploy y revisar las transcripciones                      | Detecta respuestas raras antes que el cliente                     | Bajo     | No                       |
| 2   | **Memoria de estilo y de cliente persistente** (hoy la sesión vive en memoria y se pierde al reiniciar)          | El bot recuerda nombre, trato, mascota y último pedido entre días | Medio    | No                       |
| 3   | **"Lo mismo de la vez pasada"**: recompra con un mensaje usando el historial de pedidos                          | Recompra en segundos; ideal para alimento recurrente              | Medio    | Ya existe el endpoint    |
| 4   | **Perfil de mascota** (especie, raza, tamaño, edad, alergias) preguntado de forma natural una sola vez           | Recomendaciones correctas ("croquetas raza grande sin grano")     | Medio    | Sí, campos en Customer   |
| 5   | **Fotos del producto en la respuesta** (enviar `imageUrl` del catálogo como imagen de WhatsApp)                  | El cliente confirma visualmente lo que compra                     | Bajo     | No (ya viene `imageUrl`) |
| 6   | **Botones y listas interactivas de WhatsApp** para confirmar ("Sí, confirmar" / "Cambiar") y elegir presentación | Menos errores de interpretación, conversaciones más cortas        | Medio    | No                       |
| 7   | **Atención humana con contexto**: al escalar, el operador recibe resumen, carrito y última foto                  | Respuesta humana más rápida                                       | Medio    | No                       |

## Prioridad media

| #   | Propuesta                                                                                                          | Beneficio                                             | Esfuerzo | Backend                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------- | -------------------------- |
| 8   | **Recordatorio de recompra** ("a Max se le está acabando el alimento") con plantilla aprobada y consentimiento     | Ventas recurrentes                                    | Medio    | Sí, plantillas y opt-in    |
| 9   | **Notas de voz**: transcribir audio y responder como texto                                                         | Muchos clientes mandan audios                         | Medio    | No                         |
| 10  | **Sugerencias complementarias** discretas (arena + alimento de gato, premios) solo después de resolver la consulta | Ticket promedio mayor sin sonar a vendedor insistente | Bajo     | No                         |
| 11  | **Búsqueda por similitud de imagen** contra las fotos del catálogo, además de la descripción                       | Reconocer productos sin etiqueta visible              | Alto     | Sí, embeddings de imágenes |
| 12  | **Horario y ubicación** con mapa de la sucursal para recoger                                                       | Menos preguntas repetidas                             | Bajo     | Ya existe pickupLocation   |

## Calidad y operación

- **Tablero de conversaciones**: tasa de pedidos confirmados, escalamientos, respuestas "no entendí" y costo de IA por día.
- **Revisión semanal de 20 conversaciones reales** para alimentar nuevos escenarios de evaluación.
- **Tope duro de gasto de IA** (hoy solo avisa): cortar con una respuesta amable y escalar a humano.
- **Pruebas A/B de mensajes** clave (resumen del pedido, datos de transferencia) para medir conversión.

## Pendientes conocidos de esta ronda

- La evaluación con OpenAI real no se ha corrido: falta `OPENAI_API_KEY` en el `.env` local.
- Los avisos que se envían más tarde (comprobante revisado, zona revisada) todavía no conocen el estilo del cliente si no está guardado; ver el reporte de la tarea T2.
