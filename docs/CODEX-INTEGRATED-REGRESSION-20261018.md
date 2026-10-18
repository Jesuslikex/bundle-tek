# Integrated regression and launch-panel readiness

18 October 2026. The complete run finished with one failing readiness assertion. The subsequent fix passed its focused verification; a new full-source green run is still required.

## Complete original run

Source: `08ca7c2eeee3b30e357a93f44c3695550021440c`. Run: `work/release-qa/full-suite-integrated-20261018`, handle 65071. Started 15:06:57.804 UTC, finished 15:38:33.111 UTC.

- Vitest: 572 files, 5,026 tests, 5,025 passed, one failed, zero skipped/pending/todo and zero unhandled errors. The 692 suite count in the JSON includes nested suites; it is not the file count.
- Native scripts: eight files, 35 tests, all passed; zero failed, cancelled, skipped or todo.
- Combined: 580 files, 5,061 tests, 5,060 passed and one failed. The overall wrapper exited 1. This is not a green full-suite result.
- All 1,784 captured source/configuration files were unchanged. Digest: `47d12047f4289b43468df38d3f4d77e204a201faed08e48a9f84c39fde86fa54`. Harness hashes were unchanged, source verifier exited 0, HEAD remained the captured commit and the index was empty.
- The user's uncommitted `AGENTS.md` coordination edit was preserved. It is outside the application/configuration snapshot and was not staged.

The run used pinned Node 24, the repository Vitest configuration, two workers and `envDir:false`. The offline preload rejected unmocked external Node fetch/socket connections while permitting loopback fixtures and IPC; its preflight passed. Native script tests ran after Vitest even though Vitest failed. No competing tests, builds, provider QA or source edits ran during the freeze.

Retained evidence: `.json`, `.log`, `.exit.json`, `.source.json`, `.source-verify.json`, `.config.mjs`, and `run-full-suite-integrated-20261018.mjs` under `work/release-qa/`. The original failed artifacts are retained without overwriting them. The log also contains React `act` and chart/markup warnings; zero unhandled errors does not mean warning-free output.

## Failure and bounded fix

`components/launch/pump-holder-launch-review.test.tsx`, test “opens planning with the actual mint candidate without unlocking or signing”, failed at the non-null panel assertion, line 215 in the original source. Its `vi.waitFor` used the one-second default while `next/dynamic` loaded and transformed the real planner and its dependencies. The other 15 tests in that file passed.

The test now awaits `vi.dynamicImportSettled()` inside React `act` before checking the panel. The installed Vitest API explicitly waits for dynamic imports and imports started during that wait. This removes the short polling race without mocking the planner, preloading it instead of exercising the real lazy path, extending financial lifetimes, changing production imports or weakening any assertion. The mint, explanatory copy and zero-unlock/sign assertions remain.

## Focused verification after the fix

Pinned Node 24, external Node network boundary enabled, two workers, environment files disabled: eight files and 69 tests passed together, exit 0. Report: `work/release-qa/holder-layer-readiness-20261018.json`; configuration: matching `.config.mjs`.

Files: holder launch review, layer planner, complete group review UI, native coverage UI, layer history parser, native coverage model, native coverage service and group review model. These include actual owned route/service/local SQL composition where their tests provide it, with synthetic providers and signing fixtures. They do not establish funded execution or live provider reliability.

The changed test passed scoped type-aware lint, formatting and diff checks. No production application file changed for this fix, so no new rendered-browser or production-build claim is made. This focused pass does not replace the failed complete run. Coordinate the next combined source freeze after the separately owned account-session and funding recovery work is ready.

No push, deployment, hosted SQL, provider/credential/cron change, real wallet unlock/sign/send or funded transaction occurred. Stock signing and all consent gates remain unchanged.
