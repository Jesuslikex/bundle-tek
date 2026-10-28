# Deployment readiness

Nothing here has been deployed. This records what a release would need and what has actually been proved locally, so the gap is explicit rather than discovered mid-release.

## Current state

- `vercel.json` sets `git.deploymentEnabled: false`, so a push does not deploy. Releases are manual.
- All 161 migrations apply cleanly to an empty database: 1,135 schema objects, `integrity_check` ok, zero foreign-key violations, 199 tables. Re-check with `scripts/migrate-turso.mjs --local <new-file>` then `scripts/check-database.mjs <new-file>`.
- `npm run build` passes on the current tree.
- The full suite is green (961 files, 13,359 tests) as of `c7292fe`.

## Required environment

The app fails closed without these; each throws a readable error rather than starting half-configured.

| Variable | Why |
| --- | --- |
| `TURSO_DATABASE_URL` | Database. `file:` works locally; remote needs `libsql:`/`https:` plus a token. |
| `TURSO_AUTH_TOKEN` | Required for any non-`file:` database. |
| `BETTER_AUTH_SECRET` | 32+ characters. Without it every `/api/auth/*` route 500s and the UI shows "sign-in cancelled". |
| `BETTER_AUTH_URL` | Absolute origin of the deployment. |
| `CRON_SECRET` | Guards the two cron routes. |
| `SOLANA_MAINNET_RPC_URL` | Without it everything falls back to the public endpoint, which cannot run Jito at all and cannot sustain stock qualification (see below). |
| `JUPITER_API_KEY` | Quotes and orders. |
| `MARKETPLACE_SELLER_WALLET` | Payout address. `pay-prepare` returns 503 without it. |
| `MARKETPLACE_KEY_SECRET` | 32+ characters. Delivered keys cannot be sealed without it. |

Optional: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (Google sign-in), `SOLANA_INDEXER_RPC_URL`, `SOLANA_STOCK_RUNTIME_RPC_URL`, `SOLANA_HOLDER_RPC_URL`, `SOLANA_DEVNET_RPC_URL`, `NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL`/`_WS_URL`, `SOLANA_STOCK_RUNTIME_ACCOUNT_LIMIT`.

Stock signing is off unless `SOLANA_STOCK_SIGNING_ENABLED` is exactly `true`. Qualification needs `SOLANA_STOCK_RUNTIME_RPC_URL` set to the same URL as the indexer and `SOLANA_STOCK_RUNTIME_METHODS_PER_SECOND=16`; the pacing override only applies when the runtime URL equals the endpoint, and at the default 9 the pipeline overruns the 32-slot bound. Jito needs `SOLANA_HOLDER_RPC_URL` pointing at an Alchemy mainnet endpoint — the public endpoint answers `simulateBundle` with 410.

## Before a release

1. Decide the RPC. The public endpoint rate-limits at ~6 methods/s and the stock pipeline needs ~11 s, so qualification refuses on the 32-slot span. A paid endpoint is the difference between "runs" and "qualifies".
2. Run the full suite with git on PATH (see `SKILL.md`); the checksum test fails without it and looks like a regression.
3. Apply pending migrations to the target database and verify the ledger, then re-run the integrity check against it.
4. Confirm `MARKETPLACE_SELLER_WALLET` and `MARKETPLACE_KEY_SECRET` are set before opening the seller console, or publishing silently produces undeliverable listings.
5. Re-check `git.deploymentEnabled` â€” leaving it false means a push deploys nothing.

## What is not proved

- No hosted database has been migrated.
- No signed-in production session has been exercised.
- Stock qualification is repeatable on SOL only. USDC refuses on the early minimum-output guard over roughly 0.33 bps, which is thin liquidity, not a fault.
- Jito qualifies in roughly one run in three; the rest refuse on provider fee-bank or simulation spread.
- Nothing has been signed or broadcast, so no funded trade has run end to end.
- The marketplace has never taken a real payment; the delivery path has only run against fixtures.
