# Account panel regression repair

18 October 2026. The full combined regression at `b66b3f8d0d176feaf1d452a663b01d98fab32fa8` finished with 5,107/5,108 Vitest tests passing across 580 files, and all 35 native script tests passing. All 1,805 source hashes and harness hashes were unchanged. The original failed evidence remains under `work/release-qa/full-suite-parity-integration-20261018`; see `CODEX-PARITY-INTEGRATION-REGRESSION-20261018.md`. The repair starts after the reporting checkpoint `c3b9925`.

## Cause and change

The real `AccountPerformancePanel` also mounts `AccountLaunchActivityPanel`, which automatically reads saved launch activity. The old test helper returned the same `Response` instance for every request. Launch activity consumed its JSON body before the manual performance request, causing the performance-unavailable alert. A focused run reproduced exactly the full-run failure before editing: two tests passed and the empty-state test failed at line 66.

The helper now routes launch activity and manual performance/cost requests to separate response bodies and rejects unexpected endpoints. The original empty-state, no-calendar and no-results-table assertions remain. It also verifies the two exact requested endpoints. A new real-component integration case proves an HTML launch-history error remains in that panel while a successful empty trading-history response still renders its proper empty state without a trading error. React `act` awaits completion; the arbitrary ten-millisecond sleep is removed.

Only `components/account-panels.test.tsx` changes. No production component, provider, authentication rule, acquisition calculation or authority changes.

## Verification

Pinned Node 24.19.0, two Vitest workers, environment files disabled and the existing offline preload rejecting unmocked external Node network calls: **45/45 tests in seven files pass**, exit 0. Files: account panels, launch activity UI, launch costs UI, launch activity model, recorded Pump costs model, and both account launch activity/cost routes. Provider and account data are declared test fixtures; no live account or provider request was made.

Evidence: `work/release-qa/account-panel-before-fix-20261018.log`, `account-panel-after-fix-20261018.log`, and `account-panel-fix-20261018.json` with its matching configuration. The before-fix log remains intact; the final JSON describes the focused passing run. Scoped type-aware lint, formatting and diff checks cover the changed test. Production source is unchanged by this repair, so no new build or rendered-browser claim is made. The failed full run is not relabelled green; this is a focused repair and regression pass.

## Remaining economic parity work

Current-source audit confirms `readOwnedPumpGroupChainEffects` is a manual read with no persistence, and its version-one report retains participant deltas rather than full account/inner-instruction evidence. Existing imported acquisition snapshots consume swap receipts, not launch purchases. Opening a launched token workspace does not create purchase basis. Simulation principal/rent estimates and reviewed ceilings cannot fill this gap.

The next integrated accounting feature needs durable exact finalized launch purchase evidence, actual quote/principal and account-rent attribution, deterministic shared fee/tip allocation, append-only owner-scoped source/consumption storage and real sale selection/performance integration. Token-quote principal must retain its own units; cross-wallet transfers need inherited-basis provenance. Missing evidence must remain unknown. The ignored design audit is `work/release-qa/launch-acquisition-gap-audit-20261018.md`. These are outstanding requirements, not implemented or verified capabilities.

No funding, wallet unlock, real signing/send, transaction, hosted SQL, provider/credential change, push or deployment occurred. Concurrent launch-entry/account-session areas and the user's unstaged `AGENTS.md` are preserved.
