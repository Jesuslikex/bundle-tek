# Current offline full-suite audit, 18 October 2026

Status: original full run finished with failures; focused corrections pass. A fresh combined run is required before calling the corrected source fully green.

The previous integrated full-suite record covers 307 files/2,153 tests on older source. Current main `84a9b032a5eaaa51acfa20d7fb5e64c3be24ef37` has 565 test files after the strategy, volume, funding, launch and token-layout changes. This audit checks integration across the current application rather than inferring broad readiness from focused selections.

## Frozen source and invocation

The other Bundle chat agreed to freeze canonical application/test/config/public source, Git index and HEAD until the actual process is terminal. Read-only reference investigation and ignored prototypes/docs remain separate. The normal guarded local HTTPS process stays running; this audit does not build, deploy, migrate a hosted database or change providers.

The existing release-source-snapshot tool captured 1,746 files, digest `5d08e5486a573da76378cc324c37f45acafff2829e5a77e1b70239ba5233a353`. Scope: tracked/non-ignored files under app, components, lib, db, drizzle, scripts, test, hooks, workers and public, plus its explicit configuration list. It excludes credentials, environment files, runtime work and documentation. A final verification and separate run-harness hash check are required before claiming unchanged-source success.

Confirmed live execution handle: 89140; child Vitest PID 48376 at launch. Start 06:37:41.755Z. Never restart because a poll times out; poll this specific handle or inspect its actual process/terminal evidence. The report prefix is `work/release-qa/full-suite-proxima-20261018`:

- `.source.json`: source snapshot.
- `.log`: complete stdout/stderr, including progress reporter events.
- `.json`: terminal Vitest JSON report, not available until the reporter completes.
- `.exit.json`: wrapper's terminal test exit, source verification exit and harness integrity result.
- `.source-verify.json`: final source hash comparison.

Pinned Node 24 runs `node_modules/vitest/vitest.mjs run --config work/release-qa/full-suite-proxima-20261018.config.mjs --maxWorkers=2`. The run-scoped config inherits the actual repository config and exclusion of work/**, disables environment-file loading, and adds JSON/progress reporting. Known QA-export flags are removed only from the child environment. No live-provider opt-in is set.

A temporary Node preload blocks unmocked external fetch/socket connections while allowing local loopback and local IPC fixtures. A preflight verified external fetch and socket refusal and successful loopback HTTP. It applies only to this test process and its Node children; it is not an OS firewall or a change to the normal application. Test-owned fetch mocks and disposable D1/libSQL services retain their ordinary semantics. No real key, wallet unlock, funding, signature submission, transaction or external account write is requested by this run.

## Completion requirements

Wait for the actual child/wrapper to finish; inspect JSON success/fail/pending counts, unhandled errors, process exit and both source/harness checks. Collect all failures before changing frozen source. Fix genuine regressions with owned, reviewed changes and appropriate verification, preserving the original failed evidence. This audit alone cannot establish Proxima feature completeness, production behavior, market/program qualification, audited P&L or funded execution acceptance. The overall product goal remains active.

## Original terminal result and diagnosis

Handle 89140 finished at 07:07:53.806Z, exit 1: 565 files, 555 passed/10 failed; 4,938 Vitest tests, 4,936 passed/two failed; zero unhandled errors. Duration 1,809.34 seconds. Source verification passed with the original 1,746-file digest and no changes; all four run-harness hashes remained identical. Original reports are preserved under the original prefix and never overwritten.

Eight failed files were native `node:test` suites collected by Vitest, which reported "No test suite found" after native assertions ran. `package.json` now runs `test:unit` followed by `test:scripts`; Vitest excludes only the script `.test.mjs` convention. Both sets remain required by `npm test` and `npm run check`. No test file or assertion was removed.

The checksum assertion failed on 0035's reverse raw-working-byte hash. A complete comparison found exactly four mixed-EOL historical working copies: 0035, 0036, 0057 and 0066. Each contains one physical CRLF outside quoted SQL, with canonical checksum exactly matching Git's SQL. The alias registry now records those four exact raw hashes against their exact canonical migration hashes. No SQL bytes, checksum algorithm, ledger or migration command changed. Arbitrary mixed layouts, changed comments/literals/whitespace, wrong migration tags and aliases bound to different canonical SQL remain rejected by the existing tests.

The signing rollback test reached its final signing-event count query and failed on Miniflare's loopback connection: `connect EADDRINUSE 127.0.0.1:64886`. This was a fixture transport error, not a failed rollback assertion. Production signing/recovery and its tests are unchanged. The complete focused signing suite, including all link/event/gate rollback variants, subsequently passed.

## Focused correction validation

Under the same offline preload, `work/release-qa/full-suite-proxima-focused-20261018.run.mjs` ran:

- Vitest `app/api/imported-projects/signing/route.test.ts` plus `scripts/migration-checksums.test.ts`: two files, 49/49 tests passed, 167.96 seconds. JSON and full log retained under the focused prefix. The migration suite includes the actual command against all 111 migrations in a disposable local database and rejection checks for every audited alias.
- Native Node `--test scripts/*.test.mjs`: eight files, 33/33 tests passed, zero skipped/cancelled. Includes real loopback HTTPS-guard forwarding, timing/Clock evidence, fixed-campaign refusal handling and reference identity checks. Native log retained under the focused prefix.
- Scoped typed lint for `vitest.config.mjs`, formatting of that config plus package/alias JSON, and `git diff --check` passed.

The peer's documentation-only checkpoint `5517191` preserves the unapplied wallet workspace proposal. No application source changed during this audit or these corrections. The original full result plus focused reruns must not be relabelled as a clean corrected-source full run. No production build is claimed for these metadata/test-entry corrections; no provider, real account, wallet, remote migration, funding, signature, transaction, push or deployment was performed.
