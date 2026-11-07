# Conversation quality, tone mirroring and product image recognition

Overnight audit and improvement of the WhatsApp bot's conversation ("alma"), confirmation recognition, and product recognition from customer photos. Branch `feat/conversation-quality` (from main 25b23ea); owner pushes and merges.

## Specs

- S1 Persona: the bot presents itself as the sales assistant of **Tienda de mascotas HoundFe** (pet food and accessories store), not "empresa de tecnología y productos para retail y punto de venta". Owner answer: "Tienda de mascotas HoundFe".
- S2 Tone mirroring in every message: "si el usuario manda emojis, el chatbot tambien si es serio, el chatbot mantiene el ambiente/conversacion igual, profesional, serio". Owner answer on address: "Reflejar tú o usted" — start with usted; if the customer uses tú, the bot uses tú. Emojis and formality mirror the customer. The personality must hold "en todos los mensajes", including fixed/deterministic replies where feasible.
- S3 Confirmation recognition: "si el chatbot me esta pidiendo confirmacion de algo, y el cliente le contesta si, por favor el chatbot deberia considerar esa respuesta como la confirmacion que esperaba". Natural affirmative replies ("si", "sí", "si por favor", "claro", "va", "ok", with or without accents/emojis/punctuation) to a pending confirmation must count as that confirmation; negatives must count as decline.
- S4 Audit: "quisiera que audites este tipo de cosas, que encuentres fallos en esto, los corrijas, mejores la calidad de la conversacion".
- S5 Product image recognition: "cuando el cliente manda una imagen de un producto diciendo: "?Tienen este producto??" el chatbot deberia saber que producto es, buscarlo en el sistema y si encuentra considencisas, regresarlo y si no encuentra, mandar opciones". Owner answer for no match: "Similares del catálogo" (same brand, product type or similar size) and "Pedir otra foto/etiqueta" (ask for a label photo or name when the image is unclear). Transfer receipts must keep going to the receipt flow.
- S6 Proposals: "puedes hacer propuestas de mejora de este chatbot para que sea un chatbot de primer nivel."
- S7 Live LLM evaluation budget: "Hasta $5 USD" of OpenAI spend tonight.

## Tasks

| ID  | Specs  | Route                                                                  | Commit |
| --- | ------ | ---------------------------------------------------------------------- | ------ |
| T1  | S4     | explore: map prompt, confirmation handling, image routing, vision port | —      |
| T2  | S1, S2 | persona + tone mirroring in prompt and fixed replies                   | —      |
| T3  | S3     | confirmation recognition fixes                                         | —      |
| T4  | S5     | product image recognition                                              | —      |
| T5  | S4, S7 | live conversation eval within budget, fix findings                     | —      |
| T6  | S6     | proposals doc                                                          | —      |

## Log

- L1 (2026-11-07, owner verbatim): "Bien, guarda bien todos estos pasos especificos para el chatbot, poruqe ahora mismo no lo puedo hacer, ya hice mucho del backend, ya esta desplegado y funcionando, pero el chatbot no, lo haremos manana, pero mientras, no quiero que no hagas nada, quiero que me ayudes a 1: mejorar la conversacion y el "alma" del chatbot, el tema es que ahora mismo el chatbot no responde con la personalidad que deberia responder en todos los mensajes, y mis clientes me comentarios que quisieran que la personalidad del usuario, si el usuario manda emojis, el chatbot tambien si es serio, el chatbot mantiene el ambiente/conversacion igual, profesional, serio, me sigues?? y tambien quiero que ahora si reconozca las palabras correctamente, si el chatbot me esta pidiendo confirmacion de algo, y el cliente le contesta si, por favor el chatbot deberia considerar esa respuesta como la confirmacion que esperaba, me sigues?? quisiera que audites este tipo de cosas, que encuentres fallos en esto, los corrijas, mejores la calidad de la conversacion y tambien algo mas, quisiera que trabajaras en incorporar visualizacion de imagenes, cuando el cliente manda una imagen de un producto diciendo: "?Tienen este producto??" el chatbot deberia saber que producto es, buscarlo en el sistema y si encuentra considencisas, regresarlo y si no encuentra, mandar opciones, me sigues?? quiero que mientras yo duermo, hagas una auditoria y mejoras en toda la calidad de la conversacion del chatbot, y tambien que agregues la visualizacion de imagenes. si tienes preguntas/dudas hazmelas saber ahora. Coordinate con el backend si es necesario o si necesitas algo de el. puedes hacer propuestas de mejora de este chatbot para que sea un chatbot de primer nivel."
- L2: Owner answers — business "Tienda de mascotas HoundFe"; address "Reflejar tú o usted"; live eval "Hasta $5 USD"; photo without match "Similares del catálogo" + "Pedir otra foto/etiqueta".
- L3: Deploy steps saved in docs/chatbot-production-deploy.md (25b23ea on main).
- L4: T1 map (explorer): customers go through MinimalCatalogAgentService (SYSTEM_PROMPT + INSTRUCTIONS), not SALE_FLOW_INSTRUCTIONS. Persona says "empresa de tecnología…"; usted and emojis are forced. Defects: D1 order gate drops the pending order on "Sí, por favor" (strict /^(si|sí)\.?$/); D2 delivery-data gate loops on non-strict affirmatives; D3 negatives not handled deterministically; D4 trailing !/emoji/newline rejected; D6 an image with no placed sale gets operator copy "Primero registra la venta en el sistema." and product photos are treated as receipts (caption never reaches the LLM). No tone memory. Routing: W1=T3 and W3=T4 in parallel (disjoint), then W2=T2 tone over prompt + fixed replies.
