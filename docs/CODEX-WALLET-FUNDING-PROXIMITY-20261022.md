# Selected-wallet funding-time indicators

22 October 2026. Source base: `7052a7c04dfb8d6c7a6a22852309034957d20ac7`.

## User flow and evidence scope

In Wallets, select active Solana wallets in the current filtered list, across pages, then choose **Check recorded funding times**. This is an explicit saved-record read, not a funding operation. Up to100 wallets are checked. Rows with a retained time show a clock; pairs strictly under30minutes show red text such as **24m 34s apart**. Native details/summary controls disclose the closest recorded peer and timestamp. Known-time and unknown counts remain visible. Exactly30minutes is outside the red threshold. No selection, funding schedule, budget, consent or transaction is changed.

The comparison uses the most recently **saved** successful native SOL transfer receipt to each selected wallet. Its block timestamp supplies the time, never wallet metadata, balance, creation time or observation time. It is not necessarily the latest transfer on chain. Earlier/external funding can be absent, and this is not first-funding history. Imported or externally funded wallets can correctly show **Funding time unknown**. Zero close pairs is not proof that wallets are unlinked, safe, independently controlled or aged. The indicator is a recorded-event comparison, not a running countdown or a claim of full Proxima parity.

The authenticated SELECT-only POST at `/api/wallet-workspace/funding-times` requires same origin, JSON and a strict unique address/revision selection. Body streaming stops above12000bytes; the read has a15-second timeout. Ownership, active Solana status and exact current revisions are checked before and after receipt projection. Each of the three SELECTs binds only owner plus one JSON address array. No provider/RPC call, database write, key access or signing path is added.

Receipts are read from the caller's existing retained native withdrawals. Existing packet/signature/receipt consistency validation is reused; this is not fresh independent chain re-observation. Token transfers are excluded. Rank is chosen before validation so invalid latest evidence does not silently fall back to an older valid receipt. Missing/null/future/invalid block times remain unknown. The response contains only selected identity/revision and a signature, slot and block time or explicit unknown reason; no packet bytes or wallet secrets.

Client admission matches the exact ordered selection and revisions, caps the response at1MiB and rejects raw HTML/errors. Cancel, context changes and unmount suppress late replies. A reproduced A→B→A stale-result resurrection is fixed by guarded own-state reset before a changed selection paints. Returning to a former selection requires a new explicit read. No automatic request or retry is introduced.

## Verification and actual Opus 5.5 reviews

- 64 tests pass, zero failures/skips, across seven files: new model/server/API/panel checks, real wallet-table mounting, existing roster and marketplace cases.
- A dedicated return-to-selection regression fails before the reset fix and passes afterward.
- Disposable native SQLite projection tests use real synthetic signed packet/receipt parsers. They cover ownership/revision/archived and mid-read drift, two real-parser recipient packets with a1474-second gap, invalid/null/future evidence, no fallback, token-null shape and100wallets with two parameters per SELECT. These deliberately minimal read fixtures do not qualify production financial write guards or migrations.
- DOM tests cover explicit loading, red exact-gap details, unknowns, stale/returned context, cancel/late replies, safe HTML errors, selection-limit guidance and mounting in the actual parent wallet table.
- Plain TypeScript,11-file typed lint and scoped11-file formatting pass. Existing unrelated formatting in `wallet-workspace.tsx` is preserved; its20-line integration is typed/linted and integration-tested.
- Final isolated production build and 2,396-file freeze pass with unchanged source and overlay hashes. No environment files were copied to the isolated build.

Actual `claude-opus-5-5` reviews completed read-only through Read/Glob/Grep: initial19-file source review and focused follow-up. Copied source stayed unchanged with zero permission denials. Neither reviewer ran tests or a browser; Codex owns the checks above. Initial findings led to the stale-return regression/fix, two-parameter SQL, explicit saved-record scope, native-null handling, literal deterministic tie ordering, clearer known counts and defensive oversized-panel guidance. The initial claim that the current parent could select200wallets was incorrect: its existing100wallet cap remains intact. The follow-up found no material regressions and confirmed the guarded render reset and context cleanup. Final runtime source matches its copied follow-up source.

Local ignored reports: `work/release-qa/wallet-funding-proximity-reviewed-20261022.json`, `wallet-funding-proximity-return-baseline-20261022.json`, `wallet-funding-proximity-final-freeze-20261022.json`, `wallet-funding-proximity-final-build-20261022/`, and `opus-wallet-funding-proximity[-followup]-20261022/`. The sibling evidence JSON contains portable source hashes and results.

## Limits and remaining work

Existing Chrome inventory timed out, so no fresh rendered desktop/mobile or signed-in production check is claimed. DOM tests are not a substitute for that check. The lookup scans retained withdrawals within one owner because recipient JSON has no dedicated index; large-history performance remains to qualify. The detailed reason behind an unknown badge is currently a title tooltip; pointer-independent reason disclosure remains a UI follow-up. The two schema-fault tests prove conservative read projection, not that their synthetic UPDATEs would pass production immutability triggers.

Full first-funding or external-history coverage still needs a separately bounded and qualified provider/source design. No inference from a balance or a partial activity sample is accepted. The new protocol was not previously published or deployed, so its precommit scope clarification does not replace a live v1 contract.

Protected Claude shell/token layout, existing wallet/funding/signing writers, schema/migrations, provider settings, credentials and cron are unchanged. No application/hosted SQL writes, real wallet actions, funded tests or deployment. Git deployment remains disabled;0136 unchanged and next0137 subject to recheck. Warmup execution, broader launch/automation qualification and the full product goal remain open.
