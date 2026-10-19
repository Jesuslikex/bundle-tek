# Warmup save recovery

19 October 2026. Bounded wallet-preparation follow-up on `bcbfff4`. No protected shell, account, vault, API, signing, provider, credential or migration source changed.

## Confirmed problem and repair

Recovery previously remembered only a draft ID. Cancelling an update and reloading its unchanged old revision could clear the unconfirmed-save warning and replace the form. A successful POST followed by an empty or different list could also display save success.

The client now retains the expected next revision and normalized submitted public document. Confirmation requires the exact ID, next revision, active state, name, chain, ordered addresses/tokens, amounts, reserve, cycle/timing terms, total budget and wallet revisions. The ordinary post-save refresh uses the same check. Missing, old, archived, later or different versions cannot confirm that save. No automatic mutation or retry was added.

Reloading an exact match preserves current form edits and name. Reopening stored settings remains an explicit Edit draft action, which resets the previous review through the existing parent callback. A different newer record blocks Save until an explicit reopen or New draft. Archived recovery points to Restore under Draft details. Explicit archive/restore of the pending plan clears the obsolete pending warning; New draft clears the obsolete error. Existing server revision and ownership checks remain unchanged.

The request shape remains unchanged. The existing server trims names, rebuilds canonical plan values and increments revisions by one. The client compares against that server-normalized name, not the raw name sent in the existing request. Opus's concern about an untrimmed server was checked against the actual route and does not apply. A whitespace-name regression verifies this behavior.

The shared display fixture now calculates its saved budget with the actual planner and advances saved revisions instead of returning a fixed budget/revision. Only three test files import that fixture; all are in the selected checks.

## Verification

- Seven related files passed 123 tests together: saved plans, guided warmup, cycle workflow, entry, read panels, plan model, and the real route/local database suite. The route suite uses synthetic signing/provider adapters and makes no real wallet or external request.
- A final test-only correction moved the archived-guidance assertion into the correct parameter branch. The final 30 saved-plan tests passed again. Type-aware lint and formatting passed for all three source/test paths; plain `tsc --noEmit --incremental false` passed.
- Final isolated production build including TypeScript passed, with all three source/test overlays unchanged against the final checkout. Result: `docs/qa/20261019/warmup-save-recovery/build.json`. Earlier runs are retained locally: the first compiled but its source guard refused concurrent refinements; the second caught the misplaced test-only TypeScript assertion. Neither is a final-source pass.
- Actual component Chrome checks with simulated draft storage reproduced old-revision refusal and exact-match recovery. A newer typed name remained unchanged; three reads and one draft write were observed, with no extra recovery write. Desktop1440 and phone375/320 have no horizontal overflow. Details and screenshots are under `docs/qa/20261019/warmup-save-recovery/`.
- Actual Claude Opus5.5 reviewed supplied source/diff with tools disabled and no fallback. Codex independently checked its findings, fixed stale archive warnings, preserved newer edits, improved archived guidance, and added regressions. Claude did not run tests or inspect this browser. Its review predates those final refinements.

## Limits and remaining work

Browser coverage here is explicitly synthetic component/storage QA, not a signed-in live-provider or funded end-to-end pass. No new wallet/password was created, unlocked, backed up, signed or sent. Existing historical wallet onboarding/provider results retain their original scope. The old signed-in local QA server was not listening during this turn; no unrelated server was restarted.

This local recovery state does not survive a full component unmount or reload. Archive/restore acknowledgement and general list-shape hardening were not redesigned. Staged Front/Back funding, provider qualification, distribution, launch execution and marketplace fulfillment remain separate open work. No deployment, hosted SQL, provider-setting change, cron or funded transaction occurred. Stock signing stays off.
