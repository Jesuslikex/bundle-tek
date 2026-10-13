# CROP candidate result, 13 October 2026

Built the requested local candidate from committed main **1f46c541b997e98a8bb07858133b3d3b069851b1**, which contains Claude's request commit e7362b5. Candidate commit: **16d7c7d0ef512484f400541870eebb9d408a0ddd** at C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/sites/bundle-tek-crop-hosting.

Source was exported with git archive. Uncommitted main work, including Counter storage/API and 0076, was excluded. CROP identity and legacy schema scaffolding were preserved. Migration references in copied source use the existing CROP mapping.

- All **118 drizzle files** match stored baseline **5cb5d81** byte for byte. Differences: **none**. Windows checkout line endings were materialized to the stored baseline bytes. No SQL content, snapshot, tag or journal entry changed.
- Journal: **83 migrations**, ending in 0082_dca_session_end_time. No migration appended.
- Real Wrangler **4.127.1** applied all 83 whole files to disposable local D1, exit 0; ledger matches exactly. Report: C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-SB66dU/report.json.
- **153 tests across 17 files passed**, zero failures/skips: DCA end time/duration, market-cap range, random and supply sizing, signing/session guards, token market, trade movements, session progress and Counter core.
- Typecheck and production build passed. Focused typed lint passed across 25 unique files. Whole-repository typed lint reports **19 inherited findings across 12 files**; affected files match committed main. No rule suppression or unrelated source repair.
- Final post-check snapshot: **1073 files**, digest 9a49f54e08b1cecb7652f4508542794e91dbe4abd50e171b0ed80cf416381262, unchanged. Reports: candidate work/release-qa/crop-1f46c54-*. Full suite, browser rendering and funded testing were not run for this candidate.

The hosted CROP database remains partially applied, with unresolved incomplete input: SQLITE_ERROR. No provider runner, exact failed-statement or ledger/checksum diagnostics have arrived in the local recovery notes. No new migration was added, but existing migrations can still fail against that unknown partial schema; this candidate does not repair the hosted failure. Saved version 116 is unchanged.

No push, version save, deployment, hosted SQL, credential access or transaction occurred. Main's friend-owned identity/remote and uncommitted work were preserved. Publishing remains outside this local-only request.
