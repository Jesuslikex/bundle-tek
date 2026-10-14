# Claude request: deploy current main to Vercel production

14 October 2026. The user asked Claude to request this deployment after reviewing https://bundle-tek.vercel.app/. Please act on it only after the user confirms the deployment decision in chat, as CLAUDE.md requires for deployments.

## What to deploy

- Source: committed `main` at `5608a91` or later. Build from committed content only. Do not deploy the working tree.
- Target: Vercel project `bundle-tek` (`prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `team_M6GTUdujU7FPO7CZq29qETrG`), production alias `https://bundle-tek.vercel.app/`.
- Live currently: deployment `dpl_4zW7oLbrhKDYqT6BPz8jkSYwbM2r`, source `6cd047d`.
- Not yet live: sign-in UI fixes (`5608a91`), Google sign-in and linking (`7fe7cbf`, `6c2b441`), Solana wallet sign-in (`9a611a4`), and unsigned Pump create and developer-buy packets (`6ff76f2`).
- No migration has been added since `6cd047d`, so no remote migration should be needed. Confirm this with the migration ledger check before deploying.

## Do not

- Apply remote migrations from the dirty main checkout. The two uncommitted files (`docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql`) must stay out of the deployment.
- Enable cron schedules, automatic signing or any provider change. Keep the cron endpoints disabled as documented in `docs/CODEX-VERCEL-MIGRATION-20261014.md`.
- Print, copy or log secret values (Google credentials, auth secret, RPC keys, `CRON_SECRET`). Confirm that required variables are set by name only.
- Sign, submit or broadcast any transaction, including the new Pump packets. Those require the user's own review and approval.
- Touch the friend-owned `sites` remote, CROP, or Claude-owned files.

## Before deploying

1. Confirm the Google and Solana sign-in variables are configured in the production environment by name. If one is missing, stop and report it; do not invent values.
2. Run the existing checks on the commit being deployed: typecheck, lint, production build and the sign-in, account and dashboard tests.
3. Confirm no migration is pending for the remote database.

## After deploying

1. Report the new deployment id, its source commit and whether the production alias moved to it.
2. Verify read-only over HTTPS: the home page loads, `/sign-in` shows the Google button (when configured), the "Continue without signing in" link returns to `/`, and signed-out API calls return 401.
3. Do not create accounts with real credentials and do not sign in with a user's wallet. If an account check is needed, report it as not done and let the user decide.

## Output

Write a short result note to `docs/` with the deployment id, the commit, the checks run and anything not verified. Commit it locally on `main`. Then stop and report to the user.
