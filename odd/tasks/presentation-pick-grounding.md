# Presentation pick with a number in its name fails to add to the cart

Production bug found 2026-11-18 while preparing the pay-in-store test. Branch `fix/presentation-pick-grounding`.

## Specs

- **S1 — Evidence (prod, chatbot main 825b9a8 deployed).** Options for «Tienen alimento para gato?» listed «Whiskas Gatitos Pollo en Salsa Sobre 85 g: … Sobre 85 g $18.00 MXN, Caja 12 sobres $199.00 MXN». Then:
  - «quisiera whiskas, la caja de 12 sobres por favor.» → «No pude confirmar esa operación con la información de tu mensaje. No modifiqué el carrito; ¿puedes indicarme de nuevo qué quieres?». Logs: `cart_grounding tool=adjustCartItem mode=add result=invalid_evidence reason=evidence_rejected detail=count_mismatch`, `tool getCart`, `cart_grounding tool=prepareCartItem … detail=count_mismatch`, then a searchCatalog.
  - «Quisiera la caja de 12 sobres de whiskas Gatitos Pollo en salsa por favor.» → same reply. Logs: `checkStock result=denied code=unknown_product`, `checkStock result=ok`, `cart_grounding … detail=citation_not_literal` for adjustCartItem and prepareCartItem.
- **S2 — Rule.** A customer who picks one presentation without a count adds 1 unit with «Le agregué 1 unidad; si desea otra cantidad…» (retest S5 of odd/tasks/retest-2026-11-18-fixes.md), also when the presentation name contains a number («Caja 12 sobres», «Sobre 85 g», «2 kg», «7 piezas») and the customer words it naturally («la caja de 12 sobres», «la de 12», «el sobre de 85 gramos», «la de 2 kilos»): matching of the named presentation is tolerant to connector words («de», «del», «la», «el»), accents, case, singular/plural and unit spellings (g/gr/gramos, kg/kilo/kilos), and the number inside the presentation name is never the quantity. An explicit count still wins («2 cajas de 12 sobres» → 2). A model-cited number that belongs to the presentation is never rejected as count_mismatch when no count was said: the pick defaults to 1. Ambiguous picks (two presentations match) keep asking which one.
- **S3 — No regression.** Existing cart grounding protections stay (no guessed counts, no products not shown, no adds without customer evidence). The prod case above becomes a test, plus «la de 12», «el sobre» (one match), «2 cajas de 12 sobres».
- **S4 — Evidence.** RED first with the prod case; related tests; full suite before merge.

## Tasks

| ID  | Specs | Route                                     | Commit |
| --- | ----- | ----------------------------------------- | ------ |
| T1  | S2–S4 | worker: tolerant presentation pick + default 1 | |

## Log

- **L1 (owner, 2026-11-18):** "estaba a punto de hacer la prueba en el chatbot, y mira:" with the screenshot and logs quoted in S1.
- **L2 (worker T1, 2026-11-18, uncommitted):** RED: new `minimal-cart-presentation-pick.sdk.spec.ts` (code-rendered cat-food options, Whiskas «Sobre 85 g» $18 / «Caja 12 sobres» $199) reproduced the prod logs (`detail=count_mismatch`, `detail=citation_not_literal`, the clarification reply) — 12/18 failed; the variant-id checkStock test reproduced `code=unknown_product`. Root cause: the S5 rescue matched the presentation only as the exact contiguous label (`mentionsPhrase` in `presentationPick` / `namedPresentation` / `distinctiveMatches`), so «la caja **de** 12 sobres» never named «Caja 12 sobres» and the rescue returned null, leaving the strict rejection; `unknown_product` = the model passed the shown presentation's variantId to `checkStock`. Fix: `presentationMentions` (connectors, accents, plurals, unit spellings, short refs «la de 12» / «el sobre») and `countOutsidePresentations` in `minimal-cart-request.ts`; the conversation uses them, re-reads a strict count that is only a presentation number, and treats a model number equal to the picked presentation's number as no count (one unit); `checkStock` maps a registered variant id of an allowed product to its product. Updated one ambiguity expectation (`delta 500, «500mg»` on «Si, la de 500mg» now adds one, per S2). Related 1454 passed (3 suites skipped), tsc and eslint clean; docs/minimal-cart.md updated. Full suite not run (parent).
