# Receipt payment flow

Transfer receipts end to end: the customer sends the proof, the backend stores it in DigitalOcean, a human always validates it in the system, and the customer hears the outcome.
Branch: `feat/always-on-features` (until split). Payments v1: bank transfer only.

## Specs

- S1. Owner: "el tema de los comprobantes, aqui si tiene que haber intervencion humana, y esto me lleva a algo muy importante, reconocimiento de imagnes [...] pero el reconodimiento de imagenes no significa que el comprobante de pago lo valide el chatbot, esto tiene que ser un handOff humano, si o si." The bot never confirms or rejects a receipt.
- S2. Owner: "si hermano, completmanete, estoy de acuerdo, en el backend, o sea, en digital ocean." The backend stores receipt images; the chatbot owns no bucket, public base URL or capability-signed URLs.
- S3. A receipt sent after a minimal-route order binds to that order's sale (`minimalCart.placedSale`), not to the legacy `placedSaleId`.
- S4. Image recognition only pre-fills amount, date, reference and bank, and flags a mismatch against the amount owed; the values go to the backend as extracted data, separate from what the customer declared.
- S5. The customer is told when the receipt is received and in review, and later whether it was confirmed or rejected (with a customer-safe reason).
- S6. Payments v1 are transfer only (owner, 2026-11-05).
- S8. Owner approved (2026-11-05): accept PDF receipts (WhatsApp document messages) besides JPEG/PNG: magic-byte check, 10 MB cap, encrypted PDFs rejected with a request for a screenshot, vision reads at most the first 2 pages, the chatbot never renders or interprets the PDF; the backend previews the first page as an image for reviewers.
- S9. Owner approved: on receipt the bot only says it was received and is in review (with the order folio); later it says confirmed, or rejected with the reason and a request for another receipt. No CONFIRMAR/CANCELAR or amount prompt. An image that is clearly not a receipt is not submitted and the conversation continues; an extracted amount different from the amount owed is mentioned to the customer without blocking.
- S7. No feature flag guards the flow once the backend upload exists (always-on-features S1).

## Tasks

- R1 [S3] Ingestion reads `minimalCart.placedSale` (saleId, totalCents) for the receipt's sale. Route: worker. Commit: —
- R2 [S2] Backend upload adapter replacing storage + capability in the ingestion processor and attachment service (blocked: backend upload contract). Commit: —
- R3 [S2,S7] Delete chatbot-owned storage: S3 adapter, cleanup worker, capability service and access controller, RECEIPT*STORAGE*_, RECEIPT*CAPABILITY*_, RECEIPT_MEDIA_PUBLIC_BASE_URL, store states/columns and migrations; drop RECEIPT_MEDIA_ENABLED / RECEIPT_MEDIA_INGESTION_ENABLED. After R2. Commit: —
- R4 [S1,S4,S8,S9] Vision (images and PDF first pages, receipt yes/no classification) pre-fill port and LLM adapter with timeout and budget; mismatch flag; never decides. Commit: —
- R5 [S5] Outcome notification: received/in-review message, confirmed/rejected templates from backend outcome (blocked: backend outcome contract). Commit: —
- R6 [S1,S4,S9] Replace the amount dialog (CONFIRMAR/CANCELAR) with the received/in-review message; not-a-receipt passthrough. Commit: —

## Log

- L1 (2026-11-05, owner, verbatim): "4. el tema de los comprobantes, aqui si tiene que haber intervencion humana, y esto me lleva a algo muy importante, reconocimiento de imagnes, esto es algo que ya habiamos hablado pero que no retomamos en ningun momento, y creo que fue porque hemos estado concentrados en otras cosas, y esto nos ha detenido, pero el reconodimiento de imagenes no significa que el comprobante de pago lo valide el chatbot, esto tiene que ser un handOff humano, si o si."
- L2 (2026-11-05, owner, verbatim): "si hermano, completmanete, estoy de acuerdo, en el backend, o sea, en digital ocean."
- L3 (2026-11-05): Explorer map: receipts after the minimal checkout are never processed — ingress reads `data.placedSaleId` (src/sale-flow/application/placed-sale-persistence.ts:18-23), written only by the legacy createSale tool, while the minimal order stores `data.minimalCart.placedSale` (minimal-order.service.ts:598-607); the customer gets "Primero registra la venta en el sistema." No operator notification and no confirmed/rejected outcome reaches the customer. No vision/OCR exists; only caption amount parsing.
- L4 (2026-11-05, owner, verbatim): "Si hermano, estoy de acuerdo." (accept PDF with the proposed limits; simplified received/in-review messaging)
