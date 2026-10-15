# Deterministic group regression tests

Codex scope: `lib/pump-launch-group-review-service.test.ts`, `components/launch/pump-launch-group-review.test.tsx`, and this note. No product UI, service, shared fixture, migration or Claude-owned file changes.

The immutable registration test uses the same frozen instant for JavaScript Date and SQLite `julianday('now')` expressions in its disposable in-memory schema. Every trigger condition and freshness duration stays intact. Real asynchronous timers remain enabled. Its CPU-heavy test harness timeout follows the existing 120-second suite setting; production deadlines do not change.

Signing UI tests control only Date, anchored to the synthetic review observation. The changed-context test waits for an explicit promise indicating the authorization response is held, instead of polling for 500 ms. It advances to one millisecond before authorization expiry, changes context, releases the response and checks that neither signing, local storage nor registration occurs. Timers are restored after every test.

Verified on `71e4ada` plus these test-only edits:

- Focused two-file run: 37 tests passed.
- Complete original cohort in one parallel run: **20 files, 194 tests passed, zero failures**, 381.95 seconds, `--maxWorkers=2`. SHA-256 checks confirmed both edited test files stayed unchanged throughout the run.
- Actual-source TypeScript and scoped typed lint passed. No production build was repeated for this test-only change.

Selection and command (Node 24):

```powershell
$groupTests = rg --files lib components -g 'pump-group*.test.ts' -g 'pump-group*.test.tsx' -g 'pump-launch-group*.test.ts' -g 'pump-launch-group*.test.tsx' | Where-Object { $_ -notmatch 'pump-group-broadcast' }
node node_modules/vitest/vitest.mjs run --config vitest.config.mjs --maxWorkers=2 @groupTests
```

Logs are retained in the Codex worktree at `C:\Users\Julian\Documents\Codex\2026-10-09\https-github-com-morluto-rea-https\sites\bundle-vercel\work`: `group-clock-focus.log`, `group-clock-original20-parallel.log`, `group-clock-original20.txt`, `group-clock-source-hashes.json`, `group-clock-types.log`, and `group-clock-lint.log`.

The three new broadcast test files are excluded from this historical 20-file cohort; their previous pass is recorded separately in the broadcast handoff. No push, deployment, provider operation or real-wallet action.
