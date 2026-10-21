# Cross-browser unsigned warmup recovery, 21 October 2026

This checkpoint removes the lost-browser-reminder dead end for an already saved unsigned action. Find saved preparation asks the authenticated server to select only the current pending action in the selected saved session. An optional original preparation ID can also recover older history. Neither path requests a quote or creates another preparation.

The server verifies the complete retained journal before replaying the exact original prefix bound to the immutable preparation. Plan, action, wallet, version, hash and original expiry must match. The public response contains only whitelisted preparation and original/current journal projections. It excludes private packet bytes, proof/event/source documents and owner records. Foreign and missing records have identical responses. Every recovery database operation is a SELECT; tests forbid provider fetches.

The client re-admits both journal projections and the original preparation before showing a result or publishing current metadata to the progress panel. Recovered reminders use a read-only v3 format that cannot produce a preparation POST body. An older unconfirmed local request ID is preserved as guidance, never represented as cancelled. Missing results, invalid context, cancellation and browser-storage failures cannot authorize a new attempt. Original deadlines stay unchanged, including after Stop and expiry. Signing and automatic Start remain disabled.

## Verification at checkpoint

- 877 tests pass in 33 related files. This is the selected warmup/session/receipt/API regression set, not the entire repository suite. Providers/simulations are synthetic; route tests additionally use actual disposable local SQL and real parsers. The saved-only route checks SQL statements, row counts, ownership, corrupt later history, discovery after expiry and client admission composition.
- Plain whole-project TypeScript, eleven-file type-aware lint, twelve-file formatting and git diff whitespace checks pass.
- Frozen 2723-file source digest b26c0079e4671a30aff1cdff79d2c4d2e9faa3756b2ecd4dcc0de01c868d03fc verified unchanged after checks. Artifacts: work/release-qa/warmup-context-discovery-tests-20261021.json and warmup-context-discovery-freeze-20261021.json.
- Chrome rendered the actual components/CSS in an explicitly synthetic local harness. Find saved preparation recovered original context with one GET and zero preparation POSTs. Retained review survives stopped current history and displays its original deadline. Widths 320, 375 and 1440 have no sideways overflow. Screenshot: work/warmup-context-browser-20261021/screenshots/recovered-stopped-375.png. This is not signed-in production or live-provider proof.
- Isolated production build and actual Opus5.5 read-only review are pending at this checkpoint. Report their actual outcomes in the follow-up before calling this work fully reviewed.

No migrations, hosted/application database changes, provider/credential/cron changes, protected shell/global CSS edits, wallet unlock/sign/send, funded tests or deployment. Browser reference observation: existing Chrome Proxima reported a completed50-minute two-wallet session,22 transactions per wallet and0.872/0.947SOL UI volume. Those displayed values were not independently verified on chain.

Remaining product work includes fresh per-action long-session runtime qualification, shared wallet/lot reservations, short signing authorization, execution and terminal recovery orchestration, plus funded end-to-end proof with specific user approval. This checkpoint does not establish Proxima feature parity.
