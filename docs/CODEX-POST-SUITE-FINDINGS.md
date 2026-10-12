# Findings reviewed after the frozen full-suite result

The frozen whole-checkout verification completed under execution handle `49028` with exit code 0 at 18:36:21 on 12 October 2026. Its JSON report confirms 1,750 passed tests, 10 skipped and zero failures. Application and test source were unchanged during that run. Later edits have separate focused verification.

## Warmup workflow diagnostic

The run emitted `Warmup approval failed { stage: 'saved approval', status: null }` for each of the nominal vault/external/restored native-SOL buy-to-sell workflow cases in `app/api/wallet-workspace/warmup/plans/route.test.ts`. These cases intentionally exercise rejection paths as well as nominal success. Logs alone do not establish failed assertions or their cause.

Required follow-up: inspect the terminal JSON assertion failures and first error before changing anything. If these cases failed, isolate the exact assertion/route cause in the current repo. Preserve Claude's protected timing/fixture/reliability changes. Do not weaken assertions or relax signing guards to obtain a pass.

Resolution: the terminal report has no failed assertions. These diagnostic logs did not represent failed nominal workflow tests. No warmup route, fixture or signing guard was changed in response.

## Reinspection classification version conflict

`lib/supply-movement-summary.ts` deduplicates signatures using a fingerprint containing token balance facts and material classification fields. Any different fingerprint for a previously seen signature returns `ok: false`.

That protects against contradictory facts, but it also withholds totals when an immutable older record is unresolved and a later manual reinspection has matching slot/balances with a newly supported classification. This is relevant after introducing the new protocol decoders. The current UI explicitly offers manual reinspection to refresh classifications, so the aggregate needs a reviewed rule for compatible reclassification instead of treating every algorithm update as a chain conflict.

The follow-up implemented below preserves exact slot, before/after balances, delta and precision. Contradictory known protocols, quote amounts/assets or settlement evidence withhold totals. Equal-time or invalid-provenance differences are not silently selected. Newer unresolved evidence removes an older known label. Coverage remains partial even if net balances match.

This began as a source-review finding, not a live browser reproduction. The regression was subsequently reproduced and repaired locally as described below. No signature, submission, provider call, credential access, migration, push or deployment occurred during this review.

## Reclassification resolution

The two promotion/downgrade regression tests reproduced the original conflict behavior in the real checkout before the fix. After integration, signatures must still match exact slot, before/after units, delta and precision. Known trade/transfer interpretations must agree on material classification, protocol, quote and settlement-account fields across all retained versions. Timestamp ordering never hides a contradictory earlier known interpretation.

Compatible unknown/known versions select the latest canonical server inspection timestamp with a valid finalized anchor and provider hostname. A newer unknown version downgrades the prior label. Equal-time differences, invalid provenance and material contradictions withhold totals in every input order. Explanation changes and counterparty ordering do not create a conflict.

Nineteen tests across helper, activity rendering and movement evidence rendering passed; TypeScript, scoped lint and all five production-build stages passed. The rendered summary counts the upgraded transaction once and retains partial-coverage wording. The baseline full suite predates this change. No protected Claude file was changed. The build's existing large client chunk warning remains.
