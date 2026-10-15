# Remove stale Vinext type setup

15 October 2026. Requested by Claude/user after `2380d60`; implemented on current local `main` source `930e7f1`.

## Cause and change

The main checkout's ignored/generated `next-env.d.ts` still imported `vinext/types`. That compatibility shim replaced Next's configuration types, so plain TypeScript rejected `agentRules:false` even though installed Next 16.4.0 declares that option. A previous Next build had regenerated the worktree's `next-env.d.ts` with native Next references, explaining why worktree validation passed while main's standalone typecheck failed.

The main failure was reproduced with Node 24 and `tsc --noEmit --incremental false`: `next.config.ts(3,34): TS2353`, `agentRules` not in `NextConfig`.

Removed unused `vite.config.ts`, which loaded the old Vinext/Sites/Cloudflare hosting stack, and its dedicated dependencies: `vinext`, `@cloudflare/vite-plugin`, `@openai/sites-vite-plugin`, `@vitejs/plugin-react` and `@vitejs/plugin-rsc`. The lockfile removes 42 package entries without changing any retained package versions. Native Next is already the dev/build/start runtime. Vite/Vitest, Wrangler/Miniflare, Cloudflare worker types and the local D1 test adapters remain.

Regenerated the ignored Next type entrypoint using installed `next typegen`. Generated `next-env.d.ts` and TypeScript caches are not committed. No type cast, broad declaration, `ts-ignore` or removal of `agentRules` hides the conflict. No application/UI, `app/page.tsx`, signing safeguard, migration or provider configuration changes.

## Verification and handoff

UI test notice: the unfiltered check found an independently reproducible `launch-metadata-review.test.tsx` failure. The metadata publisher fixture shares a fetch queue with its real launch-history child, which now deliberately loads three history sources on a deferred mount. This invalidates its metadata-only request count and consumes its one-shot publication responses. Codex isolated that child in this publisher suite; the real history suite retains automatic-load coverage. Publication payload/consent, sanitized errors and explicit-retry assertions remain. This is a Codex-owned launch test change only, with no production UI or signing behavior change and no `app/page.tsx` edit.

Verification uses Node 24. The worktree passed `tsc --noEmit --incremental false`; after regenerating its ignored Next entrypoint, main also passed its ordinary `npm run typecheck`. Compiler file-list inspection resolves Next's native `dist/server/config-shared.d.ts` with no Vinext declarations.

The first unfiltered `npm run check` finished its test phase with 397 passing files/3,002 passing tests and only the metadata fixture failure above; its typecheck/build stages therefore did not run. It used `VITEST_MAX_WORKERS=2`. The failure also reproduced alone. After child isolation, the real metadata and history suites pass together: 18 tests across two files. The fresh final unfiltered check will use four workers; package scripts and Vitest configuration remain unchanged. The command does not filter test files or add skip flags. Final full-chain results will be recorded after that run; the failed diagnostic run must not be treated as a full pass.

The fixture correction also passes a new nonincremental TypeScript run and scoped type-aware lint. This local code checkpoint is ready for inspection; full-chain qualification is still pending and will be recorded in a follow-up verification commit.

When updating another existing checkout, install the updated lockfile and run `npx next typegen` once to replace any ignored Vinext-generated entrypoint. Normal Next dev/build commands also regenerate it. Neither historical `.vinext` artifact ignore rules nor old deployment notes need to be deleted to fix compiler resolution.

Nothing is pushed or deployed. No hosted database, credentials or wallet actions are involved. Main's pre-existing `docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql` remain outside this commit.
