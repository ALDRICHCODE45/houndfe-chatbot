# Stock answers and write authorization have separate authority

## Decision
Keep `generateText`, `searchCatalog`, `checkStock`, the installed SDK/provider, and the current model. Replace global stock-reply suppression and handwritten language recovery with current-turn, subject-specific verified stock evidence. Stage the change conservatively: retain the global denial for non-RESTOCK mutations while unresolved reads exist, and retain every existing RESTOCK preflight and duplicate-prevention check.

This is a design, not an implementation or proof of production parity. First reproduce the defect with unchanged catalog fixtures. Do not upgrade packages, rewrite persistence, or fix the independent notification poller in this work unit.

## Responsibilities
| Component | Owns | Does not own |
|---|---|---|
| Model | Interpret customer language; choose tools and requested subjects | Invent trusted IDs, stock facts or write permission |
| CatalogSession | Sender/TTL/provenance-valid backend references and run-local search generation | Current stock or customer consent to a transaction |
| checkStock | Validate requested reference; perform authenticated GET; validate returned identity and quantity | Modify arguments silently or authorize RESTOCK by itself |
| Private stock-read recorder | Actual executed call, target, fresh result and catalog-generation binding | Trust model text or a model-supplied success projection |
| Answer projection | Current-turn verified facts, explicitly naming their subjects | Clear unrelated failures or prove arbitrary free-form claims |
| Tool approval | Execution ordering and conservative mutation denial | Replace backend business validation |
| RESTOCK preflight | Fresh shortage check, inbound ownership, reservation/idempotency/CAS | Borrow evidence about another product or variant |

## Read contract
A private per-call record captures the server run ID, SDK call ID and completed step. A trusted subject has productId, variantId (or null), and backend display names. A verified fact has product/variant scope, available/low_stock/out_of_stock status and a consistent integer quantity. Unverified reasons are closed categories such as identity_unverified, catalog_changed, backend_error, mismatch, not_managed and inconsistent.

Only validated subject names may be displayed. A failed, ungrounded model argument is an attempted reference, not an authoritative product label. Keep such failure records for diagnostics and conservative write gating; never rename them into a successful read.

For trusted subjects, the latest completed attempt determines the displayed state. A later failure for B supersedes an earlier success for B; a failure for A does not veto a verified B. Multiple subjects remain separately named and never share evidence. Ambiguous/duplicate call identity or conflicting same-step evidence fails closed for the affected subject. Cross-turn stock facts are not persisted as current evidence.

### Catalog generation binding
Expose the existing monotonic run-local search ticket through a read-only accessor if needed. Capture it before GET and require it unchanged afterward, along with a fresh match of the requested reference. `origin + observedAt`, object equality, and deep equality are insufficient: a same-tick or byte-identical search replacement is still a new generation. No database schema change is needed.

### Provenance
Build receipts in server-owned tool execution/context, retain them privately, and admit only receipts correlated with the actual completed SDK call. Model-visible tool output may describe the result but cannot authenticate itself. Bind errors and call identity conservatively; no silent server argument override and no fabricated tool success.

## Write contract — conservative first stage
- Preserve hard denial of stock/mutation siblings in the same SDK batch.
- Preserve denial of unknown executable tools under unresolved stock conditions.
- Preserve the existing unresolved-stock denial for all non-RESTOCK mutations initially. Existing createSale/upsertCustomer/evaluateCart guards do not prove unrelated read failures are irrelevant; do not relax them opportunistically.
- The only scoped exception is `requestHumanAssistance(kind: out_of_stock)` whose exact digest product/variant matches the latest verified shortage from a prior completed step.
- This exception admits the call, not the business operation. Existing fresh RESTOCK preflight, authorization, reservations and idempotency remain final authority.
- Existing accepted-request recovery retains its receipt-backed read-only policy. Do not insert a new stock GET into that recovery service or accidentally turn recovery into new intake.
- Any possible earlier effect remains visible in the outgoing reply. Do not hide an executed or ambiguous write with stock-only copy.

## Answer contract
For a run with no stock attempt, preserve ordinary model behavior. For stock attempts with no possible write effect, use a bounded stock-focused projection derived from the latest verified records, explicitly naming the real product/presentation. Use warm Mexican Spanish and usted; do not restore a universal cold fallback as the normal answer.

Examples, subject to tests:
- `Con gusto le confirmo que [producto/presentación] sí está disponible.`
- `Por el momento no tenemos existencias de [producto/presentación].`
- For a trusted subject whose latest read failed: `No pude confirmar las existencias de [producto/presentación] en esta consulta.`

Do not display an unvalidated name from failed model arguments. If only an unbound failure exists, use a truthful generic unavailable response. A stock-focused projection may omit unrelated read-only material in a mixed turn; characterize and disclose that first-stage boundary rather than claim universal verification or append potentially contradictory model prose. Mutation/effect replies remain governed by the existing preservation rule.

This proves factual stock sentences from verified data, not general intent recognition or zero-tool honesty. A static step cap bounds execution but does not force the model to issue a stock check after search. If no verified stock fact is produced, do not claim availability. Any eventual real-model evaluation requires separate authorization.

## SDK and history
Use one bounded native SDK loop; remove dynamic recovery budget arming and server-target argument rewriting after replacement tests pass. Choose the static budget using the characterization sequence; do not assume increasing a cap forces continuation after plain text.

Keep bounded user/assistant history and detached catalog identity snapshots for the first unit. Do not persist stale stock or migrate to full ModelMessage storage as an incidental change. The partial legacy tool-message converter cannot be deleted until persisted legacy rows are assessed; no migration audit is included here.

## Alternatives considered
A consolidated availability tool could search then check stock automatically for one unambiguous result. It would change the tool API and still need relevance/variant selection rules. Defer it: preserving the existing native tools requires fewer new assumptions.

Keeping the current NLP/forced-recovery controller would retain the races and competing authorities identified by the audit. Retire it only with replacement evidence; do not delete safety tests merely because they encode the old harness.

## First proof unit (S2)
Test-only, with immutable fixtures reused across all turns. Begin with the minimal failed-A then valid-B case, a same-subject control, inconsistent quantity, and stable variants. Exercise genuine tool execution and actual runner/SDK message persistence where feasible; distinguish SDK scheduling tests from guard-only probes. Assert backend arguments, final reply and mutation denial, not just activeTools or selector return values.

Record behavioral RED against the current implementation. Keep characterization and desired behavior distinct: if a known failing regression is retained before S3, use an explicit expected-failure test and document it; do not call the product fixed or leave unexplained failures. The runtime fix is a later unit.

## Implementation boundaries and rollback
S2: existing adapter and catalog-identity integration specs; add a test fixture/helper only if essential and scoped in advance. No runtime edits.

S3 candidate surfaces: new stock-read evidence module/spec, check-stock tool/spec, adapter/spec, catalog-identity integration spec, and catalog references/spec only for generation capture. Retain inventory guard/classification/effect accounting for conservative non-RESTOCK write policy initially. Remove superseded catalog-stock-recovery module/spec and forced-loop adapter code together only after equivalent safeguards and behavior are covered.

Rollback runtime changes and removals as one coherent unit; no data migration. Source forecast remains provisional until S2 identifies the minimal seams. Every additional file or behavior needs an explicit reason, not another recovery workaround.

## Known limits and next gate
Actual production search/stock DTOs, first rejected IDs and quantity/variant details remain unknown. Stable synthetic fixtures prove the architecture class, not the incident's exact backend shape. If the backend contract permits out_of_stock with null quantity, do not invent a normalization; resolve that contract explicitly.

Next: execute the small S2 characterization, review its evidence, then define exact S3 edits. Human-answer delivery after restart remains separate work.
