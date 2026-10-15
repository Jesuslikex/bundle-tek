# Remove stale Vinext type setup

15 October 2026. Code checkpoints `ec41031`, `b81c9a4` and `d13356d` are on local main. Final accepted verification below covers committed source `d13356d`.

## Cause and cleanup

Main's ignored/generated `next-env.d.ts` still imported `vinext/types`. That compatibility shim replaced Next's configuration types, making standalone TypeScript reject `agentRules:false` even though installed Next 16.4.0 declares it. A prior Next build had regenerated the worktree entrypoint with native references, explaining the different results between checkouts. The main error was reproduced with Node 24 and nonincremental TypeScript: `next.config.ts(3,34): TS2353`.

Removed unused `vite.config.ts` and its dedicated dependencies: `vinext`, `@cloudflare/vite-plugin`, `@openai/sites-vite-plugin`, `@vitejs/plugin-react` and `@vitejs/plugin-rsc`. The lockfile removes 42 package entries without changing retained package versions. Native Next remains the dev/build/start runtime; Vite/Vitest, Wrangler/Miniflare, worker types and D1 test adapters remain.

Regenerated the ignored entrypoint with installed `next typegen` and refreshed main's dependencies. Both compiler file lists resolve native `next/dist/server/config-shared.d.ts` without Vinext declarations. Generated type entrypoints/caches are not committed. No type cast, broad declaration, `ts-ignore`, or removal of `agentRules` hides the conflict.

## Accepted verification

Final Node 24 `npm run check` exited 0 on committed source `d13356d`:

- All 398 test files and 3,003 tests passed, with zero failures or skips.
- Its ordinary `tsc --noEmit` stage passed.
- Its production Next webpack build passed.
- The normal package test script declares two parallel file workers. No worker environment override, test-name filter or skip flag was used.

Additional checks passed: fresh `tsc --noEmit --incremental false`, main's ordinary `npm run typecheck` after the final fixture commit, and scoped type-aware lint for the changed test files. All 1,323 implementation/configuration files in the source freeze remained unchanged through final qualification. Main's two pre-existing dirty files retain their original hashes.

Logs and receipts remain local under ignored `work/next-types-check-clock-qualified.log`, `work/next-types-tsc.log`, `work/next-types-typecheck-main.log`, `work/next-types-{files,files-main}.log`, `work/next-types-lint-clock.log` and `work/next-types-source-freeze.json`. Full-suite qualification used the committed worktree; unrelated main-checkout dirty files were preserved.

## Test fixture corrections and diagnostic history

The initial full test phase passed 397 files/3,002 tests and failed only metadata publication's HTML-error retry fixture. It shared one fetch queue with the real history child, which now intentionally loads three sources on a deferred mount. The publisher suite now isolates that child; the real history suite retains automatic-load integration coverage. Consent, exact publication payload, sanitized errors and explicit retry assertions remain. Both files passed together, 18 tests. This changed only a Codex-owned launch test, not production UI.

Four-worker diagnostics then exposed load-sensitive group fixtures; a later two-worker diagnostic also failed three broadcast cases. Those failed runs were stopped and are not qualification results. A worker bound alone was insufficient. The standard script uses two workers to bound local database-fixture resource use; concurrent requests and race assertions inside each test are unchanged. Claude-owned `vitest.config.mjs` is untouched.

The first broadcast case passed alone in 82 seconds with its existing 120-second test timeout. In `d13356d`, broadcast test setup pins only `Date`, and an optional clock in its disposable SQLite fixture replaces `julianday('now')` with that same instant. This follows the existing controlled-clock review fixture pattern. All production migration bytes, trigger conditions, freshness limits and native `AbortSignal` timers remain unchanged. Other fixture callers keep their previous behavior. The focused broadcast file passed all eight cases while the older failed full run was active, followed by the complete accepted run above.

The four-worker profile is not qualified by this result; its terminal-recovery timing issue was not changed in this cleanup. Passing logical-clock fixtures is not evidence of funded execution or real-provider timing.

## Ownership and handoff

No production application/UI, `app/page.tsx`, signing safeguard, migration or provider configuration changed. No push, deployment, hosted SQL, credential or real-wallet action occurred. Main's existing `docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql` remain outside these commits.

Another existing checkout should install the updated lockfile and run `npx next typegen` once to replace any ignored Vinext-generated entrypoint. Normal Next dev/build commands also regenerate it. Historical cache ignore rules and old deployment notes can remain.
