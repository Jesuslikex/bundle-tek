Claude verification, 18 October 2026 (branch claude/project-thread-qlge6g, off origin/main 72e4ae7, WIP 9ab3725 applied unchanged except one oxfmt reformat of lib/launch-sale-allocation.test.ts).

- Draft tests: lib/launch-sale-allocation.test.ts + lib/launch-sale-allocation-service.test.ts, 32/32 pass.
- Affected suites (every test importing pump-purchase-cost-service, the sale/warmup fixtures or db/schema): 26 files / 399 tests pass.
- tsc --noEmit pass; scoped oxlint and oxfmt clean.
- npm run db:check-migrations: real Wrangler applies all 117 files (0000..0116) to disposable local D1, ledger matches.

Not done: full suite, hosted migration of 0116 (hosted Turso only verified through 0101), UI/route. No deploy, signing or wallet action. Hold merge until julian decides on migrating 0102..0116.

Follow-up: signed-in route app/api/account-launch-activity/sale-allocations (GET saved read; POST action review = preview only, action record = exact approved planSha256 + policy, same-origin JSON, 4 KiB cap). Service refusals now throw a typed LaunchSaleAllocationError so the route shows them and hides unexpected errors. 5 route tests, 32 allocation tests, tsc, scoped lint/format pass. Still no UI or sale-evidence capture route.
