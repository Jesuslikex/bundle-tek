# Claude request: build a new CROP candidate from current main

13 October 2026. The user chose this option after the owned CROP source push and saved version 116 were reported. Read this together with `docs/CODEX-CROP-SOURCE-RECOVERY.md`.

## What to build

- Source: the committed `main` commit that contains this file. Build from committed content only, for example by exporting with `git archive` into a clean folder. Do not build from the working tree.
- Target: owned CROP hosting, project `appgprj_6ab6edb6b85c8191a8a67d6d5ce20684`, candidate folder `bundle-tek-crop-hosting`.
- Migration state to compare:
  - Candidate HEAD `5cb5d81` has 83 journal entries: 7 CROP legacy plus 76 Bundle entries. The last entry is `0082_dca_session_end_time`.
  - Main's journal has 76 entries. The last entry is `0075_dca_session_end_time`.

## Migration rules

- Keep every migration already in candidate `5cb5d81` byte-identical, including its existing tag mapping. Applied SQL, snapshots and journal entries are immutable.
- If main has no migration beyond `0075`, add none. If main has any migration the candidate lacks, append it only. Do not renumber or rewrite earlier entries.
- Main's working tree has an uncommitted trailing-newline change to `drizzle/0068_remarkable_frightful_four.sql`. Do not carry that change into the candidate. The candidate's `0068` must keep the bytes it already has.

## Do not

- Push, save a version, deploy, or run SQL against any hosted database.
- Touch the `sites` remote or the friend-owned original project `appgprj_6a91d7db314c8191a935ed4e1bcac806`.
- Edit Claude-owned files: `components/imported-holder-view.tsx`, `components/imported-supply-tracker.tsx`, `lib/supply-watch-wallet.ts`, `lib/performance-timeline.ts`, `components/performance-timeline.tsx`, `components/account-performance.tsx`, and the token-page files changed in `19699c6` and `873ac23`.
- Read or print `.env*` files or credentials.

## Verify before reporting

1. The candidate commit (local only) and the main commit it was built from.
2. A whole-file migration check with the real Wrangler CLI on disposable local D1. Every candidate migration must apply, and the ledger must match the candidate journal exactly.
3. A byte comparison of `drizzle/` against `5cb5d81`. List every difference. The only acceptable differences are appended entries.
4. Typecheck, lint and production build on the candidate.
5. Targeted tests on the candidate for DCA end time, DCA market-cap ranges, randomized DCA and the token workspace. Run the full suite only if time allows.

## Open risk to state in the report

The hosted CROP database is partially applied, and the hosted failure (`incomplete input: SQLITE_ERROR`) is unresolved. A new candidate cannot fix that by itself. State whether any new migration could fail on the partially applied hosted schema, and whether the provider diagnostics requested in `CODEX-CROP-SOURCE-RECOVERY.md` have arrived.

## Output

Write a short result note in `docs/` with the candidate commit hash, the verification results and any differences found. Commit it locally on `main`. Then stop. Publishing waits for the user's explicit approval.
