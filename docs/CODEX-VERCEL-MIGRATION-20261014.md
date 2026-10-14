# Bundle Tek Vercel migration

Codex branch codex/bundle-vercel is based on main 19caee1 in C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/sites/bundle-vercel. CROP and the main checkout are preserved. No support contact, paid plan, funded signing or broadcast occurred.

## Provisioned and verified

Vercel identity jesuslikex, team jesuslikexs-projects (team_M6GTUdujU7FPO7CZq29qETrG), project bundle-tek (prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS), Node 24. Turso resource database-fulvous-ferry is connected only to this project on the $0 starter plan. Terms were accepted with explicit user approval. Existing deployment protection is retained.

All original 80 migrations and the new authentication migration 0080 applied to fresh local libSQL and the new remote Turso database: 81 migrations, 351 schema objects. The migration runner sends complete Drizzle statements, uses one transaction per migration, records SHA-256 checksums, and refuses unexpected preexisting databases or changed history. It never targets CROP.

The libSQL facade preserves prepared binding, D1 result shapes and atomic batches. Tests verify trigger rejection rolls back the whole batch, blobs round-trip, conflicts report the correct affected-row count, foreign batches fail and unsafe numeric values are rejected.

Next.js replaces Vinext/Cloudflare for deployment. Server provider configuration uses process.env. Better Auth owns password hashing, sessions and database rate limits. Caller-supplied Sites identity headers are ignored. An origin guard rejects cross-origin and originless API writes. Account UI includes sign-in, sign-up and sign-out. Password recovery and email verification delivery are not configured.

Authenticated cron endpoints port the existing bounded monitor and unsigned preparation workers. Both remain disabled unless their existing enable flags and a strong CRON_SECRET are configured. No schedule was created or automatic signing enabled.

User approved transferring only existing Jupiter and Solana RPC provider settings from Bundle's ignored local configuration. JUPITER_API_KEY, SOLANA_MAINNET_RPC_URL, SOLANA_HOLDER_RPC_URL, SOLANA_INDEXER_RPC_URL and SOLANA_RPC_MIN_INTERVAL_MS were configured in development, preview and production. Auth secret was generated and stored through stdin. No credentials or wallet keys appear in source, logs or commits.

## Validation before deployment

Final production Next build and typecheck pass, including Tailwind and the account control. Targeted 86 tests passed. All 81 migrations passed locally and remotely. Actual HTTP -> Next -> Turso checks passed: forged identity rejected, session reads, project save/reload, owner isolation, PNG upload and exact byte retrieval, image owner isolation, cross-origin rejection, protected cron, sign-out and revoked-session rejection. These created explicitly named Migration QA records in the fresh database, without financial transactions.

Rendered sign-in fields were inspected in Chrome. The old runtime supplied Tailwind implicitly; explicit PostCSS configuration and Webpack development now supply it in Next. The complete Node 24 regression suite passes: 337 files, 2,390 tests, zero failures. The initial Node 26 run was stopped after jsdom failures; the affected launch UI tests pass under Node 24. Historical Miniflare route suites retain explicit test fixture injection through test/vercel-compat.ts; adapter/session integration and real HTTP runtime checks use libSQL/Turso directly.

First Vercel deployment dpl_FdsfpvBEVKh3XL2p6F9FJZfpy4MP is READY. Vercel treated the first normal deployment as production; it stayed protected during verification. The user approved public production with protected previews. ssoProtection is now prod_deployment_urls_and_all_previews (Vercel Standard Protection). Public production domain: https://bundle-tek.vercel.app/ . Private APIs remain protected by Bundle sessions.

Hosted HTTP -> Next -> Turso checks pass: 16 checks covering account creation, forged-header rejection, project save/reload and owner isolation, private PNG upload/round-trip and isolation, linking the image to a saved draft, explicit public metadata publication, unauthenticated public metadata/image retrieval, cross-origin rejection, cron protection, sign-out and session revocation. Synthetic Migration QA records and published one-pixel PNG metadata exist solely for verification. No blockchain instruction was signed or submitted.

Desktop and 390px phone sign-in views were inspected; phone document width matched viewport width (390px), with no sideways scrolling. The public dashboard rendered and its RPC status became online. A remaining legacy login link was found in project-dashboard.tsx; the follow-up changes it to /sign-in and updates three old API messages. Its related tests will be recorded in the follow-up commit. Screenshots and logs are retained under ignored work/ .

Password reset/email verification delivery and cron schedules remain unconfigured. Existing CROP, its database and main's two unrelated dirty files were not changed. This work is on codex/bundle-vercel; deployment does not require pushing to the legacy Sites remote. No claim of funded launch, Jito bundle or buy-to-sell proof. Original CROP migration error and its partial ledger remain unresolved and untouched.
