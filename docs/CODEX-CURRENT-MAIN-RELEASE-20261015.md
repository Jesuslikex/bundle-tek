# Current main production release, 15 October 2026

Bundle is live at https://bundle-tek.vercel.app/.

- Deployment: `dpl_5ckWZVyecoWBhQkADTR79a2n6nJP`, READY, production.
- Source commit: `34bcd9afbd961b8872fa9bcf9d714651e450de27` (main at release preparation).
- Unique URL: https://bundle-dpcd5owbk-jesuslikexs-projects.vercel.app/ . Production alias inspection after promotion resolved to this deployment.
- Project: `bundle-tek`, `prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `jesuslikexs-projects`.

## Source and database

An isolated Git archive with checkout EOL conversion disabled supplied the release. All 948 upload files were verified against this commit's Git blob identities. The uncommitted pair-order candidate work in the Codex worktree and main's two unrelated dirty files were excluded. Current main includes the committed stock-pair quote/mint-policy and saved-wallet preflight checkpoints; this does not complete stock-pair signing, execution or UI integration.

Fresh production environment configuration was downloaded through the existing authenticated CLI into ignored local configuration without displaying values or changing settings. Read-only ledger checks before deployment and after promotion (final check 21:10:39 UTC) matched all 89 remote migration checksums to the isolated committed source using the existing portable checksum checker. No migrations are pending. The authorized 0086, 0087 and 0088 had already been applied in the earlier release, along with prerequisite 0085. No migration or ledger write was needed for this release.

## Verification

The Vercel production webpack build, TypeScript validation, static generation and function packaging passed. The READY production build was promoted, and the alias was inspected afterwards. The source checkpoint previously passed 22 selected test files / 522 tests, actual-source TypeScript, scoped typed lint and local production build, documented in CODEX-PAIR-WALLET-PREFLIGHT-20261015.md. The full repository suite was not rerun during this release. New uncommitted candidate tests are not evidence for the deployed source.

Cookie-free HTTPS at 21:10:03 UTC confirmed:

- `/`: HTTP 200, Bundle HTML.
- `/sign-in`: HTTP 200, Bundle HTML.
- `/api/launch/pump/groups`: JSON HTTP 401, no-store, requiring sign-in.
- `/api/launch/pump`: JSON HTTP 401, no-store, requiring sign-in.

Existing Chrome rendered sign-in, then Continue without signing in opened home; Create launch opened the venue wizard and Configure token opened Token details including artwork controls. The tab error log was empty. Chrome retained existing account state visible in the workspace; this visual smoke is not proof of a clean signed-out launch session. Cookie-free HTTP is the independent anonymous check. Launch is an in-app view at `/`, not a separate `/launch` route. No credentials were entered, and no draft was saved or artwork uploaded. Signed-in functional checks remain for Claude.

A bounded error-level runtime log query completed after promotion; retained receipt is `work/release-20261015-current-runtime-errors.jsonl`. This is a short release observation, not ongoing monitoring.

No Git remote was pushed. No provider, credential, cron or access-protection setting changed. No real wallet was unlocked, no transaction was signed or sent. Main's pre-existing Jito note and 0068 SQL bytes were verified intact before and after release.

Ignored local receipts: `work/release-20261015-current-*`. Private downloaded environment configuration must not be shared. This release-record commit follows the deployed source and is documentation only.
