# Bundle production release, 15 October 2026

Production is live at https://bundle-tek.vercel.app/.

- Deployment: `dpl_FLu8zpXqYaKvHCC3aYaEomP261Jf`, READY, production.
- Source: `61591c925403996c0b865a0899e891a4dba9fad3` on main. This includes the verified `e167740` release plus the browser startup correction described below.
- Unique URL: https://bundle-laxpeg60d-jesuslikexs-projects.vercel.app/ . CLI inspection confirmed the public production alias points to this deployment.
- Project: `bundle-tek`, `prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `team_M6GTUdujU7FPO7CZq29qETrG`.

## Database

The production environment was downloaded through the existing authenticated Vercel CLI into an ignored local file, without displaying values or changing settings. The initial read-only ledger check found 85 matching migrations, with **0085 as well as 0086, 0087 and 0088 pending**. Migration 0085 creates the observation table required by 0086, so it was included as a prerequisite of the authorized release.

The existing committed `scripts/migrate-turso.mjs --remote` ran from an isolated committed-source export. It applied all four migrations transactionally, reporting 89 migrations, four newly applied and 419 schema objects. No existing ledger entry or SQL history was rewritten.

A separate read-only checksum verification against the final source at 18:58:42 UTC confirmed **all 89 remote checksums match using the existing portable checksum rules, with zero pending migrations**. The final hotfix changes only the environment module and its test, not migrations.

## Browser startup correction and release recovery

The initial `e167740` deployment, `dpl_Cm1efGguJoM8w2k8g5SJX54PsyWE`, passed its production build and anonymous HTTP checks. Rendered verification then caught `ReferenceError: process is not defined` during home-page hydration. A shared validator import reached the server environment module, whose top-level `process.env` evaluation crashed in the browser. HTTP 200 alone did not establish a working page.

The previous production deployment `dpl_8RMRGb8PscavfnatBoxWrrTzYxrr` was restored while repairing the issue. Commit `61591c9` makes importing the environment module safe without Node globals. Browser provider reads fail explicitly, including when a process shim exists; server callers retain the original live environment object. No credential value is embedded, no browser provider fallback is enabled, and no provider setting, transaction approval or signing condition changed.

The corrected committed source was exported again and deployed successfully. The CLI dry-run upload was checked against Git blob identities: all uploaded source files match the release commit, with credentials, local runtime files and uncommitted stock-pair work excluded. Claude's `app/page.tsx` was not edited.

## Verification scope

- Baseline `e167740`: previously completed `npm run check`, 398 files and 3,003 tests passing, TypeScript and production build passing. See `CODEX-NEXT-TYPES-CLEANUP-20261015.md`.
- Hotfix: three canonical test files, 11 tests passing (`server-env`, `solana-rpc`, `wallet-rpc-pacing`); scoped type-aware lint and standalone `tsc --noEmit` passed with Node 24. The full suite was not rerun after this two-file correction.
- An initial main-checkout test command also discovered old ignored scratch copies and failed there. The accepted targeted run excludes `work/**`; no test assertions or Claude-owned Vitest configuration were changed to hide those copies.
- Final Vercel production webpack build and TypeScript validation passed.
- Anonymous HTTPS at 19:03:07 UTC, without cookies: `/` and `/sign-in` return 200; `/api/launch/pump/groups` and `/api/launch/pump` return JSON 401 with `no-store`.
- Fresh existing-Chrome tab: sign-in rendered wallet/email controls; Continue without signing in opened home; Create launch opened the chain/venue wizard; Configure token opened Token details with artwork URL/upload controls and the metadata review section. Browser error log was empty during this final check. Launch is an in-app view at `/`, not a separate `/launch` URL.

The browser check did not sign in, upload artwork, save a draft, unlock a wallet, sign or send anything. Private screens, real authentication, funded execution and unfinished stock-pair work remain outside this verification. Claude can now check the signed-in production screens.

No Git remote was pushed, including pulseforge-legacy or CROP. No provider, credential, access-protection or cron setting changed. Main's pre-existing Jito note and 0068 SQL edits retain their original bytes and remain uncommitted.

Local ignored receipts are in the Codex worktree under `work/release-20261015-*` and `work/release-20261015-hotfix-*`, including the before/after ledger, verified upload, HTTP results and deployment logs. Environment files are private local configuration and must not be shared with the receipts.
