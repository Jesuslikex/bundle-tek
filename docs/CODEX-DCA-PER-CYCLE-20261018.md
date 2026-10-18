# DCA per-cycle targets and total-budget review

## Reference

Fresh REA ev_bc007f671029d3a5653eb2cd19e66149691fb56b6acb3a20e8c493f17989e371 records the unsaved AutoSell DCA form. Observed Fixed Amount/Randomized, amount/supply units, separate hours/minutes/seconds interval, market-cap range and strategy-only maximum amount/duration. The randomized view shows separate minimum/maximum amounts. Add Strategy and Run were never invoked; Close and account-route restoration completed.

Private retained bundle: C:/Users/Julian/Desktop/REA/results/proxima-dca-20261018-recaptured-evidence.json,124728bytes,3records,SHA2561ab589291e8c9f297b40dce2e47ebdd9cc7335a74a7c0d0e08a0882c7831b212. This recapture supersedes earlier inline-only form records after the REA provider/relay session reset. The earlier proxima-dca-20261018-evidence.json contains only discovery/restoration, not those form records. Zero exporter unknowns does not prove backend coverage. Windows Chrome remained live; after the missing old relay handle was confirmed, the existing approved loopback/stdio relay was restarted without launching Chrome or changing its profile. No credentials/network bodies/storage values were requested.

## Change

Model checkpoint92c3659 adds dcaPerCycleBudget: exact integer multiplication of a positive decimal by2to25 cycles, bounded by the existing u64 limit and canonical decimal formatting. It can also multiply a six-decimal percentage before the existing saved-supply calculation. Its15 model/supply tests pass, including above-Number-safe-integer amounts, overflow, input precision and percentage conservation.

The composer adds Total budget / Per-cycle target. Its default remains the existing total budget. SOL and token per-cycle inputs produce identical exact entry amounts; saved-supply percentages produce an exact total percentage, then reuse the existing conservative aggregate rounding and even allocation. The UI explicitly says percentage cycle amounts can differ by one atom and lists every exact amount. For the17-atom fixture,10%target times3 means30%total,5atoms budget and2/2/1atoms. It is not falsely presented as three identical token-atom spends.

The total input, unit, count and additional fee/rent caveat remain visible before save. Mode changes clear the numeric amount rather than reinterpret it. Switching a per-cycle input to randomized sizing clears it and returns to total-budget mode; randomized allocation rules remain unchanged. Mode participates in the draft/allocation identity, so changed interpretations cannot reuse saved status or a stale random preview. Invalid count, precision, overflow and percentages above100% yield local feedback and disable saving.

No new server request field is introduced. The exact converted total still passes through dcaTradeSessionInput, tradeSessionTerms, original cycle entries, saved supply capture, count/interval/budget validation, immutable saved-session identity and existing per-cycle eligibility/approval/signature/submission/recovery. Server routes, SQL and signing predicates are unchanged.

## Verification and ownership

Five selected model/UI files passed39tests together. The earlier15 model tests and existing total/random/supply regressions are included. New mounted cases cover SOL total recalculation on count change, exact request entries, token/supply targets and declared rounding, mode/random invalidation, overflow and over100% refusal. Plain TypeScript, scoped typed lint and formatting pass. A separately launched actual signing/session route and sizing/market regression remains pending under process33523 when this checkpoint is written; no pass is attributed to that unfinished run. An earlier command named a nonexistent trade-sessions/route.test.ts and selected only four existing files,34tests; it is not route evidence.

Chrome rendered the real component with public production CSS in an isolated4190 fixture, refusing all requests except a synthetic in-memory session save. Verified0.001SOLpercycle times3 gives0.003total and three1000000-atom entries; explicit save returns the reviewed session without signing. Supply10%times3 shows30%total, the rounding note and2/2/1atoms, then saves those same entries.375x812 viewport has clientWidth/scrollWidth360 with no page overflow and was reset. Ignored screenshots: work/dca-per-cycle-qa/buy-desktop.png, supply-desktop.png and supply-mobile.png. These are synthetic UI saves, not authenticated production or funded proof.

Review current progress explicitly approved this DCA selector/summary scope. Its vault/onboarding, app/page, protected token/holder/performance layouts and shared CSS are untouched. Its warmup quote-helper dirty files are excluded from this commit. Source is frozen for that chat's one shared build and guarded HTTPS recovery; this task does not build/restart it. No provider/credential setting, wallet key/password action, funding, signing, submission, migration, cron, push or deployment.

Still open for full Proxima parity: HMS timing controls, multi-strategy composition and independent strategy/session ending semantics, wider strategy/venue coverage, supplier-backed marketplace and full holder/financial audit. This checkpoint completes per-cycle input review only, not the full goal or autonomous execution.
