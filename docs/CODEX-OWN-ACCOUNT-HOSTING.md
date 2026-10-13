# Bundle Tek own-account hosting

12 October 2026. The user confirmed that the original site's Chrome account belongs to a friend, and approved hosting Bundle under their own account instead.

The original checkout and `.openai/hosting.json` retain their original project identity. A separate sanitized source export is at `C:\Users\Julian\Documents\Codex\2026-10-09\https-github-com-morluto-rea-https\sites\bundle-tek-own-account`. It includes application source, public assets, tests, and the migration chain. It excludes Git history, local environment files, runtime state, hosted records, and local credentials. Its hosting manifest declares D1 `DB` but has no project ID.

Exactly one new-site registration was attempted with slug `bundle-tek`. Sites rejected the request: "You've reached your Site Hosting usage limit. You can keep using existing Sites, but you can't create a new Site until your limit resets." No site ID or write credential was returned. No source push, deployment, original-site change, or database mutation occurred. Do not retry creation until the quota changes. No reset time was supplied.

Next hosting action requires either available new-site quota or the user's selection of an existing site to repurpose. Do not overwrite an unrelated existing site automatically. Revalidate and refresh the source export before publication. Configure hosted provider secrets through supported Sites settings without copying or printing local `.env` contents. Existing hosted user IDs differ between sites; data migration requires an authorized export and explicit ownership mapping, not a blind database copy.

The product goal remains incomplete. Local regression evidence and a source export do not prove a hosted operational product or funded execution.

## Selected existing hosting and failed deployment

The user selected **CROP · Agent World Testnet**, project `appgprj_6ab6edb6b85c8191a8a67d6d5ce20684`, public URL https://crop-agent-world-testnet.chris-toney0702.chatgpt.site/. Its original source was opened through the supported source helper in a separate checkout at `sites/bundle-tek-crop-hosting` beside the export. Version 113 and original source commit `6649caa1dc188f199dd721de319111637202d840` are retained recovery references. No attached Sites automations were returned.

The deployment copy preserves the seven original migrations byte-for-byte, eight legacy tables and schema declarations. Bundle's 69 migrations are appended as 0007 through 0075, with combined snapshots and an ordered journal. Test fixtures in this deployment copy use the mapped names; the original Bundle checkout is unchanged by this mapping. A disposable D1 test applies the combined chain and retains a seeded legacy world_state record. TypeScript, migration and public v1 transaction regressions and production build passed. No local credentials or hosted records were copied. Hosted environment revision 0 has zero configured keys.

The supported source helper committed and pushed exact candidate `c48ec680c434e1af52ae225fdaf7805a702b7fe6`. Windows shell interoperability broke its packaging step. A native Windows adapter then used the unchanged shared prepare-site-build.cjs validator and equivalent staging/migration packaging contract. The archive excludes .env, Git and node_modules. Sites saved version **114**, archive SHA256 `623574f70c7406d52ac06d89e6fc02aa4348e4b33fbb737ddceb1b54a4ec0067`.

Deployment `appgdep_6acd2b4e00208191af7da0b614eb1636` ended **failed** with `incomplete input: SQLITE_ERROR`. The fresh database overview confirms partially applied Bundle schema. warmup_signing_events exists with its original 14 columns and zero rows in a one-row read, while the overview lacks later imported signing tables. This narrows the failing area to the signing migration sequence but does not expose the migration ledger or exact failed statement. Worker error logs are empty; they do not explain a migration-parser failure.

Do not blindly redeploy, rewrite applied migrations or delete partial tables. Resolve exact hosted migration state and statement splitting through supported Sites diagnostics first. The live upgrade and provider setup are incomplete. Version 114 being saved and pushed is not a successful production publication. The original friend's PulseForge hosting identity remains preserved.

## Follow-up: version 115 remains blocked

Wrangler splitting reproduced an incomplete statement at the nested =CASE expression in 0065_imported_trade_sessions. A one-space formatting repair preserves the trigger semantics and now passes every migration through both native SQLite and actual D1 statement execution. All migration-owned tables, indexes and triggers reconcile. The corrected commit 04be5e1120f0a906cd168437986f1a10640d5d34 was saved as version 115, but deployment appgdep_6acd2da50c808191a3996c5bb1a20435 returned the same hosted error. The original error is therefore not fully explained by the local splitter defect. No third retry occurred. The overview's 50-name list does not reliably identify the last applied migration. Exact hosted runner/statement/ledger diagnostics are required; see CODEX-SITES-MIGRATION-BLOCKER.md.

## Refreshed local candidate, 13 October 2026

The separate CROP candidate now includes the current 997-file Bundle source snapshot (digest 730897e9cac301a35edfee924b9ba1eca0ca2b5ba7f8aaaea02b4cabcecb00b5), with 898 eligible application/config/test/public files refreshed. It includes the Jito checkpoint 81daaea and later uncommitted chart/history source; DEPLOYMENT-SOURCE.json explicitly records that distinction. No credentials or hosted data were copied.

The existing 76 candidate SQL migrations, hosting identity, legacy CROP schema declaration and previous final snapshot retain their exact hashes. Only three migrations were appended: 0076_amusing_viper (Jito events), 0077_overjoyed_betty_ross (finalization receipts) and 0078_curious_glorian (conditional-order events). The combined chain now has 79 migrations: seven legacy CROP plus 72 Bundle. Prior journal records and the retained CASE-spacing correction were preserved. New snapshots include legacy table metadata and maintain their predecessor chain.

All three migration tests pass across native SQLite, actual Miniflare D1 and Wrangler statement splitting, including a seeded legacy world_state record retained across the complete chain. The old hard-coded 76-migration expectation was updated to 79; the initial failure report remains retained. Candidate TypeScript and the production build passed. Logs are under the candidate's work/ folder: candidate-migrations-final-20261013.log and candidate-build-20261013.log. The refresh provenance and preserved hash report is crop-candidate-refresh-20261013.json beside the candidate preparation script in this task directory.

No candidate source commit, push, archive upload, deployment, hosted database write or provider-credential change was performed in this refresh. Saved public version 115 and its failed deployment are historical states, not this newer local candidate. Exact hosted migration-runner/statement/ledger diagnostics remain required before recovery or publication; passing local splitting does not resolve that blocker. The main full-suite run continues against its unchanged snapshot.
