# Standard Pump launch Front/Back planning entry

18 October 2026. This change makes the existing planning workspace reachable in the ordinary create-only Pump launch flow, without requiring a holder-buy target. The holder review uses the same entry.

## Behavior

A shared lazy client entry is mounted immediately below each review's actual public mint address. Its selection contains the saved project ID, exact update stamp and candidate mint. An identity change remounts the entry closed and disposes the old planner. Closing disposes pending reads through the existing request generation and abort cleanup. Equivalent selection rerenders preserve an open entry. Busy launch actions disable the entry and planner controls.

The disclosure has an explicit button type, expanded state and controls relationship to its mounted panel. The heavy planner stays dynamically loaded; no vault, key, signing or sending logic was added to the entry. Opening it alone does not read providers or mutate storage. Loading wallets/history remains the planner's explicit read action.

The ordinary and holder signing/preparation handlers, consents and funding authority are unchanged. The planner still says staged funding and execution are unavailable. No route, schema, committed migration, protected shell/layout or Claude-owned file was changed.

## Verification

Final offline Vitest run: 12 files, 142 tests passed together, zero failed/pending/todo. Retained JSON/config: work/release-qa/launch-entry-final-20261018. Coverage includes both actual review components, the real dynamically imported shared planner, project/update/mint replacement, busy controls, pending read cancellation, existing planner history, native coverage, API, service and terms checks. The new create-only integration confirms zero holder buys, the actual candidate and no unlocking/signing or extra request on opening. The original first run also passed 142 tests; its evidence is retained separately.

Whole-project TypeScript, five-file type-aware lint, formatting and diff whitespace checks passed. TypeScript initially found a new test's DOM append method colliding with ambient worker types; using appendChild corrected it before the final test run. TypeScript passed before the other account owner's later receipt/schema draft appeared; this is not qualification of that unrelated uncommitted work. Existing planner history tests emit React act warnings; they pass, and this change does not claim those warnings are resolved.

Chrome rendered the actual create-only review and shared planner with current generated theme CSS and a synthetic public-only mint header. At 1440px the document client/scroll width was 1440/1440, at 375px 360/360 and at 320px 305/305. Opening, manual read refusal, closing and reopening worked; the stale synthetic read error cleared and all approval checkboxes stayed unchecked. Screenshots and fixture source: work/launch-entry-qa-20261018, including desktop.png, mobile.png, narrow.png and final-mobile.png. The fixture blocks non-GET/provider requests, uses invalid synthetic ciphertext and refuses crypto decrypt/sign. It does not prove actual wallet backup decryption, authenticated provider reads or funded execution. The fixture tab/server were closed and viewport reset. Production signing was never invoked.

The isolated browser bundle passed. No new Next production build or new full-suite green result is claimed for this patch. The earlier failed combined run at b66b3f8 remains intact; its account fixture failure is separately fixed by its owner in 32fca77 with 45 scoped tests. That focused fix does not retroactively make the old full run green.

## Remaining parity gaps

StonkFun needs a separate planning entry outside the Pump-only financial handler; do not enable unsupported signing by changing that gate. Imported-token planning needs an explicit owned current target/revision plus scheduled-plan rules. The client selection and context parser currently accept only new-token targets, so a token-layout button alone would not implement it. Those remain work, alongside staged distribution, fresh required-funding calculations and execution qualification. This patch is one visible launch-workflow improvement, not full Proxima parity.

No push, deployment, hosted SQL, provider/credential/cron change, real wallet unlock, signature or funded transaction occurred.
