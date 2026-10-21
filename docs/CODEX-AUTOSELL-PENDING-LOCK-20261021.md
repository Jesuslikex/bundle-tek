# Auto Sell: retain the run lock while an operation settles

Source base: `bfb6a19b6c6c799ae262786f22872e181bcc77e4`. Source-only fix in the owned Auto Sell component. No deployment or funded activity.

## Problem and change

The actual Opus 5.5 operational review identified a lifecycle race. Project/wallet revision or workspace-lock changes replace the Auto Sell context; roster loading can also remove it. Cleanup stopped the runner and cleared the browser vault but unconditionally released the Web Lock. A previously started executor operation can still settle after cancellation, particularly the existing submit request that deliberately does not cancel a possibly accepted send. Its final update returned early after unmount, so the old lock was already gone and a remounted instance could start another run while that operation was still pending.

Cleanup now retains the existing lock when `snapshot().selling` is true. Each constructed runner owns an idempotent release closure over its original acquisition. Its terminal update releases that exact lock when both running and selling are false, before the mounted/current-instance guard. React updates still require that guard. Teardown still aborts new work and erases the unlocked wallet payload; it does not wait for the network before clearing secrets. No pending-operation timeout or automatic retry is added.

The original context keys, engine/evaluator, executor, provider, API and financial limits are unchanged. A remount still stops the old session. A new explicitly started run can acquire the lock only after the old operation settles, under the original Web Locks behavior. The error now accurately describes an active or settling run instead of asserting that it must be in another tab.

## Independent reproduction and verification

The six initial controlled-promise tests use the actual component and runner with a fake vault, feed, held executor and Web Locks implementation. They never sign, send, unlock a real vault or contact a provider.

- Against the exact committed `bfb6a19` component loaded through an isolated test-only Vite loader, five cases fail at the early-release assertion: project change, wallet change, workspace lock, unmount and page-hide. Explicit Stop already passes. The application file was not reverted to run this comparison. The original failing report is retained at `work/release-qa/auto-sell-pending-lock-baseline-20261021.json`.
- All six pass after the fix. Remounted instances cannot unlock/start while the old operation is pending, and may start only after settlement releases the original lock. Secrets are cleared and the old executor's signal is aborted at teardown.
- Six more cases cover ordinary/uncertain rejection after unmount, Stop then unmount, session expiry during a pending sell, a late vault unlock with the real lock protocol mocked, and a paused live session retaining its lock after the operation settles. They verify exactly-once release and no React error after unmount.
- The final combined Auto Sell cohort passes **204 tests in 21 files**, with zero failures or skipped tests. Report: `work/release-qa/auto-sell-pending-lock-final-expanded-20261021.json`. Earlier combined 198-test and six-case reports are retained, not summed as additional distinct tests.
- Whole-project plain TypeScript, two-file typed lint and formatting pass. No new hook, API, JSX layout or accessibility control was introduced; effect ownership and state updates were explicitly checked.

Actual `claude-opus-5-5` reviewed the initial lock fix read-only from 17:32:12Z to 17:34:45Z, with requested/selected/used model metadata matching and zero permission denials, edits or tests. All copied sources remained unchanged. It found no critical/high/medium issue within this patch and confirmed the terminal release, stale-instance guard and pending-unlock behavior. Original evidence: `work/release-qa/opus-auto-sell-pending-lock-bfb6a19-20261021/`. Its suggested extra tests and clearer error wording were independently implemented and verified afterward; they were not rereviewed by Opus. It could not run a Git diff and reviewed the copied current code plus described scope. Codex verified the actual diff independently.

Build details and exact final source hashes are recorded in `CODEX-AUTOSELL-PENDING-LOCK-EVIDENCE-20261021.json`. The build uses an isolated committed-source copy plus the two exact owned overlays and no local environment file or production credentials. It does not deploy.

## Limits and next work

- This is a browser-lifetime run lock, not a durable financial reservation. Actual browser/page destruction can release a browser lock while remote work continues. The original unsupported-Web-Locks fallback and project-specific lock name are unchanged and remain gaps to audit.
- Outcome logs and lookup references still disappear on remount or log truncation. This fix preserves exclusion while settling; it does not supply persistent recovery, restore counters, verify finality or cancel a transaction. Saved preparation history remains necessary.
- A server timeout is not proof that a transaction failed. Conservative unknown-outcome accounting and all existing execution checks remain unchanged.
- Ordinary Chrome control timed out again after the user confirmed the connection. No final rendered, signed-in production, live-provider or funded check is claimed for this fix. Existing prior screenshots are not represented as this source's rendered proof.
- No protected Claude parent/layout/global CSS, schema, migration, db guard, application/hosted SQL, provider setting, credential, cron, wallet action or deployment changed. Migration 0135 remains immutable; 0136 still needs a fresh ownership check before use.

Full Proxima parity remains active and unproven. See `CODEX-PROXIMA-PARITY-REBASE-20261021.md` for the broader evidence checklist and outstanding warmup/automation work.
