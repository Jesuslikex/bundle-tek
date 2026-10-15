# Stock-pair runtime preview production release

Bundle is live at https://bundle-tek.vercel.app/ on 15 October 2026.

- Deployment: `dpl_C2jmmfnfpKq7DrJjXjfMbaReXFho`, READY, production.
- Source: `d62300e5c0da80bddd92fa00faf35539fe712e49`, current main at preparation, descended from the requested e167740.
- Unique URL: https://bundle-hppztxzyo-jesuslikexs-projects.vercel.app/ . Production alias inspection confirmed this deployment after promotion.
- Target: existing bundle-tek project, jesuslikexs-projects team.

The release used an isolated Git archive. All 960 uploaded files matched committed Git blobs. Main's two unrelated dirty files and the Codex worktree's incomplete intermediate-account changes were excluded. No remote was pushed.

The existing portable checksum checker matched all 89 remote migration ledger entries to this committed source before release and again at 22:31:45 UTC after promotion. No migrations were pending. Authorized migrations 0086, 0087 and 0088 were already applied; no remote SQL write or ledger rewrite was needed.

The Vercel production webpack build, TypeScript validation, static generation and function packaging passed before promotion. Source qualification is documented in CODEX-PAIR-RUNTIME-PREVIEW-20261015.md: 671 tests in 30 selected files, local build, TypeScript and scoped typed lint. No repository-wide test suite was rerun for this deployment. Stock-pair runtime previews remain unsigned evidence and do not enable stock-pair signing or execution; the incomplete auxiliary-account work remains local.

Cookie-free HTTP at 22:31:34 UTC returned 200 for home and sign-in, and JSON 401/no-store for /api/launch/pump/groups and /api/launch/pump. A new nonpersistent Chrome browser session, without signing in, rendered sign-in, Continue without signing in, the dashboard, Create launch, Configure token and Token details with artwork controls. Launch is an in-app view at /, not a separate /launch route. No draft save, upload, account login or wallet operation was attempted. Browser console entries were three expected protected-data HTTP 401s and a CSS preload warning; no other console errors were observed. Signed-in functional checks remain for Claude.

Main's dirty Jito note and 0068 SQL hashes were verified unchanged. No provider, credential or cron configuration changed. Existing production environment settings were downloaded privately for verification without displaying values. No real wallet was unlocked, and nothing was signed or submitted.

Ignored receipts use work/release-20261015-runtime-*; browser snapshots are in ignored .playwright-cli. Keep downloaded environment files private. This record is a documentation checkpoint after the deployed source.
