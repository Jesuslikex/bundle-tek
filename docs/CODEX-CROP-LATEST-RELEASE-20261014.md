# Latest Bundle source saved in CROP, hosted migration failure unresolved

14 October 2026. User requested migration repair and latest Bundle publication. The source/release preparation is completed, but the hosted migration failure is not fixed and publication remains blocked. No deployment retry or hosted SQL was performed.

## Verified release checkpoint

- Main application source: 8e50b3937c89e70a61f13f0ee2728cad0691caad, exported from committed Git content only. The two unrelated uncommitted whitespace edits were excluded.
- CROP candidate/source commit: **1ed5e9b2925bfdce9e9cffc5af6b0f9145aa9a85**, normal non-force push verified in the owned CROP source repository.
- Saved version: **117**, ID `appgprj_6ab6edb6b85c8191a8a67d6d5ce20684~appgver_30813a6694488191a9d2f4de0f2d230a`. Save response reports `deployment_id=null`.
- Site: `appgprj_6ab6edb6b85c8191a8a67d6d5ce20684`, CROP Agent World Testnet, https://crop-agent-world-testnet.chris-toney0702.chatgpt.site/ .
- Candidate folder: C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/sites/bundle-tek-crop-hosting.

Current Counter work, image/metadata release, Pump create-only approval/signing/recovery and UI are now included. All 83 existing migration journal entries and 119 retained SQL/snapshot/identity/legacy files remain identical to candidate 16d7c7d. Four migrations were appended with the existing +7 mapping: 0083_flaky_crusher_hogan, 0084_worried_owl, 0085_lush_rictor, 0086_real_justice. The chain has 87 migrations.

## Verification

140 targeted tests across 21 files passed, including legacy CROP world_state retention through the full upgrade, exact local-D1 schema agreement, Pump/image/metadata APIs, browser approval controls, Counter reservations/quotes and DCA. TypeScript, nine-file type-aware lint and production build passed. The real Wrangler CLI applied all 87 whole migration files to fresh disposable D1 and checked the ledger. The full application suite was not rerun.

Reports: candidate work/release-qa/crop-refresh-targeted-20261014.json and crop-refresh-build-20261014.log; C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-Da8hB1/report.json. The frozen 1,149-file source digest is 31cc447dcbc87b7c4dbd65e5d52bb5b0d51f929105214fe68d8c1190a6e2cb5c and remained unchanged during checks. Refresh provenance/retained hashes: C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/crop-refresh-8e50b39-20261014.json.

Worker archive: C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/bundle-tek-crop-1ed5e9b-20261014.tar. Local compressed-file SHA256 is 73e7b8c725573e095e8e3673f2b329a8b3c56dc1b34cd847478cedaaf2ba1a70. Sites reports stored archive hash sha256:47f1216ccf1525629de28671b861fd7dffaf3e370424d844905c1ae3b68cb2ae and 425 files; this is the server-returned archive identity, not the raw compressed-file hash. Packaging verified all 117 retained migration files, selected project ID, journal count and exclusion of credential files. The retained Windows adapter uses the current Sites build validator and equivalent Worker staging contract. A path-separator guard and refreshed plugin path were corrected during packaging; source did not change. Credentials were supplied through hidden stdin, not persisted; automatic publication was disabled.

## Current hosted evidence and required repair input

Version 115 deployment `appgdep_6acd2da50c808191a3996c5bb1a20435` still reports `incomplete input: SQLITE_ERROR`, last updated 2026-10-12T18:57:47.366116+00:00. Version 116 was saved without deployment; version 117 is also saved without deployment. The current database overview exposes 50 user tables and no migration ledger or trigger definitions. A bounded warmup_signing_events read shows the same 14 columns and zero rows. This does not identify the failed migration or last successful statement.

Available Sites tools cannot return the runner/execution method, exact failed SQL or applied migration checksums. The tested local CASE-spacing issue is already fixed in CROP 0065 and did not resolve version 115. The old trigger-comment relocation remains a hypothesis, not a verified hosted repair. Prior SQL has not been rewritten, security triggers have not been dropped, and the database has not been reset.

The Sites skill storage reference requires: "Applied SQL, snapshots, and journal entries are immutable" and "resolve uncertain migration state before changing history." Current read source: C:/Users/Julian/.codex/plugins/cache/openai-curated-remote/sites/1.0.2-remix-b.1/skills/sites/references/storage.md, referenced by its SKILL.md. This applies because the failed deployments already left a partial schema. A fresh-local passing chain cannot establish what the hosted runner previously applied.

Platform diagnostic request, ready for forwarding:

For project appgprj_6ab6edb6b85c8191a8a67d6d5ce20684 and deployment appgdep_6acd2da50c808191a3996c5bb1a20435, please provide (1) migration runner/version and split/execution method, (2) failed migration filename and exact SQL statement including boundaries, (3) applied journal/ledger and checksums including the failed migration's status, and (4) last successful statement and affected trigger definitions. Please provide a supported recovery path preserving CROP's legacy records and already applied migration history. Version 117 is saved and held; no retry has been requested.

No support message has been sent. Once this evidence is available, repair only the positively identified unapplied statement or use the platform's reconciled recovery, then validate and deploy the saved/rebuilt matching source. Hosted provider configuration and a user-approved funded launch remain separate verification steps; no live wallet signing, transaction or claim of full launch parity occurred.
