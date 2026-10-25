# Durable Auto Sell run journal foundation

25 October 2026. Source base `c3c37c7`.

This adds server-owned run identity, conservative allowance accounting and an association at the actual unsigned-preparation writer. The existing browser runner and modal remain unchanged. Durable browser continuation, settlement, signing authorization and execution are still unfinished.

## Implemented

An authenticated metadata API records a run from an exact owned saved profile and current project/token/wallet sources. Its immutable basis retains the complete owned-wallet exclusion roster, selected wallet revisions, original database start/active/end clocks and derived strategy/session limits. History remains readable when current sources change. Profiles continue to mean saved configuration; they are not relabelled as resumable progress.

Each immutable attempt has a run/head hash, sequence, stable strategy/occurrence identity, selected wallet/revision, exact input and server-preallocated preparation UUID. DCA draws and next due times are retained without catch-up; Limit rows and Counter source identifiers cannot be claimed twice. These are accounting inputs, not independently qualified market/trading decisions. Counter source evidence and replication must be verified before any execution enablement.

Every reservation remains charged. Three base1,000,000,000 integer limbs preserve exact session/strategy accounting above2^53, signed64-bit and cumulative U64. No floating conversion or `SUM(CAST(raw AS INTEGER))` is used. A second pre-created run cannot bypass held allowance on the same owner's wallet/mint. Stop blocks new work and keeps exposure; it never cancels transfers or releases wallet/signature reservations.

The internal unsigned adapter derives inputs from the owned run and attempt. It invokes its one-shot start **after** the existing provider-key,200-history and both15-second gates, immediately before the first provider call. Known preflight refusals leave the start unused. Unknown provider outcomes retain the start and allowance. A private branded guard and SQL-time source/roster/head/amount/slippage/deadline checks bind the actual `saveSwapPreparation` insert to the preallocated UUID. A browser cannot attach an unrelated manual preparation afterwards. Pending unpublished starts serialize new starts/reservations in the run; exact head checks are retained.

All journal signing, execution and automatic-resume flags remain false. SQL refuses both insert and update of signing intents for journal-reserved preparation IDs. The adapter has no public prepare route, and the metadata API accepts no signing/submission action. The unused preclaimed-guard entry point was removed; only the server-side lazy-start callback remains. Ordinary three-argument preparation and ordinary history writes preserve their original validation, SQL and bindings.

## Verification

- **772 tests across47 files pass** on Node24. The cohort covers all matching Auto Sell library/component suites, saved-profile and new metadata APIs, actual D1/Turso journal engines, the actual preparation adapter, and existing imported preparation/conditional regressions. It includes29 adapter cases, a full1000-attempt canonical history, above-U64 cumulative arithmetic, pre-created-run reservation races, pending-provider serialization, actual writer publication, lost-response/replay, source drift, immutable/replacement/rowid guards and SQL signing refusal.
- Actual native and local D1 tests cover20 hostile, self-consistent raw metadata/hash inserts, including oversized/zero-padded caps and false lifetimes. Original30-day strategy durations remain supported;24h+1 and exactly30days reserve/replay successfully. The original session limit stays24hours.
- Plain TypeScript, twelve-file typed lint and thirteen-file source formatting pass. This was API/database composition; no new browser or full production-build claim is made.
- All152 whole-file migrations apply through Wrangler's real local command. A separate native upgrade preserves151 prior ledger checksums,186 old table snapshots and seeded funding rows, with integrity/foreign-key checks passing. New `0153_auto_sell_runs` is source-only, timestamp1794860000014. Claude0147 stays reserved; next0154 requires fresh inspection.
- Source-derived AST comparisons prove the full ordinary preparation function and writer admission/SQL/binds unchanged after removing only the added internal journal branches. Nineteen protected parent, runner/executor, profile, vault, signing, Jito and deployment files, and all151 prior migrations, remain unchanged.

Two actual Claude Opus5.5 source-only reviews completed with unchanged review copies and zero permission denials. The first identified the cross-run allowance race and deterministic-start/head liveness issues. These were fixed with SQL-time cross-run exclusion, serialized unpublished starts and lazy admission. The follow-up found no blocker within the foundation and confirmed the D1 expression-depth refactoring preserved all original predicates in one atomic trigger. Final unused-entry-point removal and canonical-cap/lifetime/duration corrections were independently tested after that snapshot; no final-snapshot Opus approval is claimed. Claude did not run tests.

## Remaining work and release boundary

This foundation does not resume an existing browser run. The existing runner still keeps its counters in memory. Before connecting it, implement canonical preparation/packet recovery, receipt-bound settlement or provably unsigned closure, retained configuration/control epochs and fresh explicit resume consent. Missing responses or HTTP404 must never reset allowance or cause another send. A browser snapshot, saved profile or submitted state is not finalized execution evidence.

No allowance is released yet. An unfinished provider start can therefore hold a run indefinitely, and held attempts prevent a fresh same-owner wallet/mint run. Published status is inspected separately through the existing exact preparation history. Raw unsigned packet bytes are not retained by that history and cannot be reconstructed or freshly re-prepared as a claimed continuation. DCA draws/Counter inputs remain caller-proposed metadata. Uncapped configurations preserve their existing meaning and must not become execution authority without server-qualified decisions. Cross-owner wallet coordination still relies on the original financial reservation system.

The run/attempt/history capacities are explicit and fail closed. Existing200-entry preparation history limits remain. New API responses are bounded to1MiB, expose lean accounting/key counts instead of the whole32MiB journal, and grant no authority. Hosted response/performance limits, live provider behavior and production authentication are unqualified here.

No application/hosted SQL, deployment, provider/credential/cron changes, real wallet unlock/sign/send, strategy run or funded action occurred. Git deployment stays disabled. Claude PR57/59/60 application files and protected parents, the four original AGENTS additions and seven frozen warmup drafts remain intact. Full legitimate Proxima parity, read-only Jito qualification and other held marketplace/launch work remain open.

Private evidence is under `work/release-qa/auto-sell-run-*`, both `opus-auto-sell-run*` directories, the semantic guard script and the disposable Wrangler report.
