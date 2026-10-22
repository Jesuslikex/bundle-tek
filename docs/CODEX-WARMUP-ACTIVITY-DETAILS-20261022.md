# Warmup Activity saved-detail recovery

22 October 2026. Base main: 7fdc570. Local source checkpoint only, no deployment or financial action.

## Result

Activity's saved-warmup detail request now uses the existing fatal-UTF8, cancellable 1 MiB JSON reader and a 30-second deadline covering headers and body. A pending read has an explicit Cancel control; timeout/cancel/changed selection/unmount suppress late replies. Reload is explicit and disabled during a read. HTTP 401, 404 and 429 have fixed guidance; HTML, malformed data and transport errors never expose server/parser diagnostics. Close remains available throughout. Native amount, total budget and fee reserve now show their currency.

Before rendering a saved plan, a new display-only decoder checks its identity, bounded shapes, captured-wallet set, range matrix and exact integer total-budget arithmetic. It does not apply the present planning start window, network allowlist or minimum delay. Expired/archived configurations remain readable; an unknown historical network uses “native units.” This is not a plan admission, token/network validation, fee estimate or signing permission. Source data must still be revalidated by the existing real workflow after the user explicitly navigates to My wallets.

## Approval history and ownership

The original Activity panel already mounted WarmupApprovalHistory, which can submit an already-signed packet, and remounted it on parent reload. The first actual Opus review identified loss of child uncertainty state through that remount. Independently confirmed against HEAD originals. Activity now uses a new viewOnly option: saved statuses, packet references and explorer links remain; cancel, submit, recovery/receipt/failure POST controls do not render, and the action handler refuses viewOnly calls. Per-signature guidance says to retain the original signature and use My wallets. The existing explicit “Open warmup in My wallets” route remains.

The default option is false. My wallets retains the original recovery behavior, unchecked approval, archive/revision/expiry checks and action implementation. No server/signing/preparation code changes. This does not certify all existing My wallets remount/recovery behavior. Plan history remains collapsed; a specifically selected public run timeline intentionally opens, as before. Its reader and history child's reader have not been hardened by this patch.

No protected Claude shell, global CSS or layout changed. No migration was reserved; journal remains 0136, next 0137 subject to recheck. No application/hosted SQL, providers, credentials, cron, wallet unlock/sign/send, funded tests or deploy.

## Verification

- Final 77 tests in eight files pass, zero failures/skips: detail UI19, decoder15, bounded reader2, existing read panels11, cycle workflow16, guided UI9, recorded-summary4 and summary interaction1.
- Plain TypeScript, six-file typed lint and formatting pass. No full suite or production build was run for this checkpoint.
- Actual source/CSS rendered in the existing Chrome profile with an isolated, credential-free synthetic GET harness. Verified fixed HTML error, manual retry, pending Cancel, cancelled state surviving a late original success, historical archived configuration and a saved signed approval with only read controls. No HTTP provider, API backend, wallet or transaction was available in that harness.
- No sideways overflow: 320 viewport /305 client /305 scroll; 375 viewport /360 client /360 scroll for expanded history; desktop1440 /1440 /1440. A cancelled375 screen measured375 /375 /375. These are component-harness results, not signed-in full-app proof. Viewport reset afterward.
- QA server PID1776 was identity-checked and stopped; port54272 no longer listens. Final working QA tab closed. Two earlier QA tabs1751430734/1751430737 could not be closed after the control tool reset (debugger unattached), and point only at that stopped local server. Original user tabs preserved. The earlier separate REA relay stop policy rejection is unchanged; no workaround attempted.

## Actual Opus 5.5 review

Two completed source-only reviews used only claude-opus-5-5 and Read/Glob/Grep: 16 and20 copied files, unchanged in each review, zero denials/edits/tests. Logs/status are under ignored work/release-qa/opus-warmup-saved-details-20261022 and sibling -final-. Opus did not run tests, a browser or provider checks.

The second review confirmed that viewOnly removes Activity writes and default My wallets behavior remains unchanged. Its remaining historical-rule dependency and missing per-signature guidance findings were independently corrected afterward and covered by the final tests/rendered checks; those last follow-ups were not rereviewed. The portable evidence records current-copy drift precisely. Its comments about unbounded child reads are pre-existing limitations, not a claim that every history panel is now hardened.

## Still open

Full Generate Activity execution still needs distinct execution consent/root admission, durable CAS/proof storage, cross-family wallet/lot exclusion, a real receipt-bound outcome writer/reconciliation and per-action runtime qualification. Current saved plan/history/progress and the in-memory lifecycle model are not a working continuous warmup loop. Full Proxima parity remains unproven; keep the original goal active.
