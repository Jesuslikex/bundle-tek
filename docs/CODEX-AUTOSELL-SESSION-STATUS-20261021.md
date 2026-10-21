# Auto Sell session counters and outcome wording

Source base: `0a6b136b5a1503a2027f6c131ea3356f60a22290`. Source-only checkpoint. No deployment or real wallet action.

## Observed gap and correction

The existing runner deliberately adds uncertain submissions to soldRaw so they cannot be sold again. Its executor returns after the submit response rather than a finalized receipt. DCA responses and limit filled IDs track processed scheduling decisions, including decisions that can add zero after a cap. The former Sold/DCA sells/filled wording therefore overstated what the browser knows.

The new read-only session panel displays original snapshot.accountedRaw exactly, including retired strategies, separately from current buffered and in-flight amounts. It shows active/paused/not-running independently of pending transaction work, distinguishes current/last run counters and explicitly says submitted or unknown transactions are not finalized sales. Stopped queues become Unsent tokens. The explanatory disclosure records the exact tab/context lifecycle and directs outstanding outcomes to preparation history. A stopped-run-only live output announces pending work and its settlement without duplicating the existing running status output.

Per-strategy counters now say Accounted, separate queue/in-flight amounts and count accepted triggers or processed intervals/targets. A pure presentation helper maps the two original engine end reasons to accounted/processed labels. Successful submit logs say submitted and Finality not verified; original error text and signature links remain intact. Paused-edit notes use accounted amounts and processed targets. No original engine reason, transition, cap, timestamp, retry, feed, executor, review/consent label, Run handler, vault/signing or receipt rule changes. Run-handler UTF8 text and five original library bodies were directly compared with the base and match exactly.

## Proxima evidence

The existing signed-in Chrome launch funding tab was inspected. Unsent Auto Sell configuration exposes Counter replication/rate/minimum supply and exclusions; DCA fixed/random amounts and hours/minutes/seconds interval; individual strategy endings; session-wide endings; a Limit amount/market-cap ladder; advanced delay/slippage/wallet controls. Only mode and disclosure controls were opened, then the actual Close restored the funding workspace. No amounts, wallet choice, Add Strategy, Run, funding or financial action occurred. No private addresses, balances or launch identifiers are published here.

REA list_browser_targets against approved loopback9223 returned provider_unavailable/endpoint_unreachable. The REA skill recovery guide was read. No registration repair, browser launch workaround or fresh REA execution/network evidence is claimed. The observations above are direct browser UI evidence, not REA capture or proof of Proxima's backend.

## Verification

Final pinned Node24 regression: **142 tests in15 Auto Sell files pass**, zero failures/skips, actual exit0. New tests exercise an actual injected runner uncertain outcome, real paused strategy retirement retaining the accounted total, an in-flight result arriving after Stop and an abort-before-send refusal. Pure display tests preserve source/error/signature objects, map end labels, keep arbitrary name text and exact BigInt precision, and withhold malformed counter displays. Existing19 lifecycle/approval cases and all original Auto Sell tests pass. Test clocks/providers/execution are synthetic, not funded proof.

Plain TypeScript, five-file typed lint and six-file formatting pass on the final unchanged2,802-file freeze, digest f9ce3eeb40c9cdf3153bef2419e15f4adcee89b4cdded1324aeb904696bfc6ed. Final isolated production build exits0 with six exact overlays and unchanged canonical/copy hashes, without application environment files or production credentials. Expected isolated-copy lockfile/no-cache warnings are retained. No whole-repository full-suite claim.

Actual claude-opus-5-5 initial and follow-up read-only reviews completed with copied files unchanged. Initial review found a mixed-encoding new test assertion (corrected before final test runs) and display/lifecycle issues. Follow-up confirmed no blocking/high/medium issues; its low/nit suggestions were independently checked and corrected, not rereviewed. One follow-up Read to a nonexistent sibling components path outside its source copy was denied; no bypass or successful outside read occurred. Neither reviewer ran tests or browsers; no fallback model was used.

## Browser status and remaining QA

An isolated loopback Vite fixture uses the actual AutoSell UI/runner with fixed clock, fake public wallet/vault/feed/executor and fetch blocked. The source before the final explanatory disclosure/live-status/suffix-only refinements rendered an uncertain outcome as Accounted5, queued0, in-flight0. Close retained the simulated session; Pause retained its counters. Desktop document width1920 had no overflow and modal width620. At375px, document375 and dialog335/335; at320px, document320 and dialog280/280. All footer actions remain44px high with Stop bottom781 inside812px. These are measurements of the preceding source, not the final compact-layout version.

During the final rendered check, the same Chrome tab stopped responding to browser control and the JavaScript kernel reset. The connection remained stalled after the completed build. No competing browser/server/tab, process restart or lower-level control was used. Final compact disclosure, stopped live announcement and full final-source layout/keyboard rendering **remain to verify**. Earlier screenshots are retained only as preceding-source synthetic evidence under ignored work/auto-sell-status-browser-20261021. Temporary viewport reset was attempted but its confirmation is unavailable. Own Vite server was stopped; own test tab is left to normal ephemeral cleanup. User Proxima tabs were preserved.

## Limits and next step

This checkpoint improves outcome clarity, not finalization or recovery execution. No new signing authority or stock/warmup gate is enabled. Existing explicitly approved browser-tab Auto Sell behavior is unchanged. Real provider/funded execution, durable recovery/orchestration and full Proxima parity remain unproven. First resume final-source browser verification when Chrome control is available, then continue the broader parity work.

No protected Claude shell/layout/global edit, migration/db, application/hosted SQL, provider/credential/cron change, real wallet unlock/sign/send, funded test or deployment. Next free migration remains0136 subject to journal/claim recheck; none needed here.
