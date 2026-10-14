# Bundle production deployment

The user explicitly approved deploying with wallet and email sign-in while Google remains hidden. This supersedes the missing-Google stop in the deployment request and the preceding preflight report. No Google credentials or consent settings were changed.

- Project: `bundle-tek`, `prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `team_M6GTUdujU7FPO7CZq29qETrG`.
- Deployed committed release: `11ad20b92c11a780d6f792dd9664f22c99bf3ab5`; application source is `e33fc8f`, with documentation-only commits afterward.
- Deployment: `dpl_FYnVoBwpWTLC6QHejGZBV6ghVTFP`, READY, production.
- Unique URL: https://bundle-6yyotgix3-jesuslikexs-projects.vercel.app/
- Public production alias: https://bundle-tek.vercel.app/ . Vercel inspect confirmed this alias resolves to the new deployment.

Deployment used the clean, linked `sites/bundle-vercel` worktree with `vercel deploy --prod --yes`. Main's existing dirty documentation and migration files were excluded and remain untouched. No friend-owned Sites/CROP remote was used. No remote migration, provider change, cron configuration, real account creation, wallet connection, message signature or transaction submission occurred.

## Verification

- Six focused sign-in, account, dashboard, Solana login and strict signature test files: 26 tests passed, Node 24.
- Actual-source TypeScript and scoped lint passed.
- Local Next.js production build passed; Vercel production build, TypeScript and publication also passed.
- Read-only remote ledger SELECT matched all 81 committed migration hashes. No migrations are pending and the migration runner was not invoked.
- Repository-wide lint reported 19 existing errors and one warning in UI primitives, a hook and PostCSS config unchanged since the preceding live source `6cd047d`. Those were not changed or hidden.
- Anonymous HTTPS `/` and `/sign-in`: HTTP 200.
- Anonymous GET `/api/projects`, `/api/wallet-workspace`, `/api/imported-projects` and `/api/launch/pump`: HTTP 401 with no-store responses.
- Anonymous `/api/auth/get-session`: HTTP 200 (the normal session lookup endpoint).
- Existing Chrome rendered the new `Bundle Tek` title, wallet and email controls, and no Google button. Expanding wallet choices showed Phantom, MetaMask and Jupiter, without selecting or connecting one.
- Clicking `Continue without signing in` navigated to `/`; the dashboard settled into its signed-out state without raw parser errors. The footer reported mainnet RPC online and swap approval required.
- Screenshot retained locally in ignored `work/production-wallet-login-20261014.png`.

## Limits

No real email or wallet authentication, private account reads, Google OAuth, funded launch, Jito or buy-to-sell execution was tested. New atomic Pump create/developer-buy preparation and independent simulation modules are included as server-internal unsigned code; they are not connected to the live signing API/UI and do not enable that execution flow. Existing Pump signing remains create-only. This is a verified release, not proof of full Proxima parity or funded execution.
