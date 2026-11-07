# First-class chatbot roadmap — slice 1

Owner-approved proposals 2, 3, 5, 6 plus two cosmetic follow-ups from the live evaluation. Branch `feat/first-class-roadmap` (from main 3cc9e69, pushed by the owner). Later proposals stay in Engram `roadmap/chatbot-first-class-proposals` and docs/propuestas-chatbot-primer-nivel.md.

## Specs

- S1 Persistent customer memory (proposal 2): "Que el bot recuerde al cliente. Hoy la conversación vive en memoria y se pierde al reiniciar el bot. Si se guarda, recuerda entre días el nombre, si lo tutea o no, su mascota y su último pedido." Later notices (receipt outcome, zone resolved, restock/expiration notices) use the stored style.
- S2 Reorder (proposal 3): "\"Lo mismo de la vez pasada\". El cliente recompra con un solo mensaje." Uses the backend order history (GET /chatbot-api/customers/by-phone/:phone/orders).
- S3 Product photo in replies (proposal 5): "Mandar la foto del producto en la respuesta. El cliente ve lo que está comprando y se equivoca menos." Uses catalog `imageUrl`.
- S4 WhatsApp buttons (proposal 6): "Botones de WhatsApp. Por ejemplo \"✅ Confirmar\" / \"✏️ Cambiar\", o una lista para elegir la presentación. Con botones no hay forma de que el bot malinterprete la respuesta y la conversación se acorta."
- S5 Cosmetic: after a cart change during checkout the cart listing is shown before the order summary (the product appears twice); a 🐾 was sent to a customer whose last messages had no emoji.

## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S5, S3 | worker: cosmetics + product photo | — |
| T2 | S4 | worker: interactive buttons and lists | — |
| T3 | S2 | worker: reorder | — |
| T4 | S1 | worker: persistent customer memory | — |
| T5 | all | live eval + full suite | — |

## Log

- L1 (2026-11-07, owner verbatim): "Si hermano, completamente, esas son con las que hay que iniciar, pero todo lo demas si me interesa mucho, por favor, no lo pierdas de vista nuca, porque iremos haciendo despues las siguientes propuestas."
- L2 (owner verbatim): "Bien hermano. por ahora, no puedo probar las funcionalidades en el navegador, pero ya pushee, por favor, sigue con los siguientes pasos en el plan, en cuanto pueda, te voy a pedir un resument de que es lo que tengo que probar en produccion."
