# Funding history from Activity, 25 October 2026

Activity's saved Solana funding-plan details previously mounted only devnet receipt history. The funding planner already had a separate mainnet reader. Activity now reuses that reader beside clearly labelled devnet test history; this does not introduce another funding or receipt implementation.

Mainnet history remains closed until explicitly opened. Existing revision filters, unresolved-attempt labels, finalized receipts, proxy-route warnings and authentication checks remain in the unchanged child. Reloading the saved draft unmounts both readers and aborts their old requests. Archived drafts retain history access. Other chains retain the existing unavailable message.

The draft read now uses the existing cancellable, 1 MiB JSON reader. Status-specific fixed messages replace raw HTTP/parser errors, and malformed rendered chain/currency fields are rejected. No financial handler, provider, database schema, signing rule, protected parent or Claude PR57/59/60 file changed.

## Verification

- 60 tests across five files pass, including 14 new Activity-history cases and the existing mainnet history/routes, devnet receipts and Activity suites.
- Plain TypeScript, two-file typed lint and formatting checked separately; final results are recorded in the companion JSON.
- Actual compiled components rendered in existing Chrome at 1920px and 375px with controlled local saved-history GET fixtures. Explicit open rendered both an unresolved attempt and a finalized delivery from an earlier revision, with the mainnet explorer link and missing-route warning. No horizontal page overflow. Only GET requests reached the loopback fixture server; no provider or production API was used.
- The first browser fixture incorrectly placed receipt observation after the record's capture time. The unchanged decoder refused it. Correcting the fixture timestamp made it render; no application check was relaxed.
- Actual Opus 5.5 read-only source review used five isolated copied files, completed successfully with no permission denials and no changed copies. Its missing chain/currency validation and positive-test suggestions were implemented and independently retested afterwards; those final follow-ups were not rereviewed by Opus.

Browser limits: this was an isolated component fixture, not a signed-in production/full-page test. The utility CSS fixture reused the earlier local compiled global stylesheet plus current ux.css. Existing browser-extension warnings were observed; no application error was observed. No deploy, hosted SQL, credentials/provider/cron changes, real wallet action or funded operation occurred.

## Claude marketplace handoff

Independent copied-source review of PR60 at `43c0b0dfb9a1d880567f8ca35900e28b94d8fca3` reproduced two blockers:

1. The actual RPC integer codec preserves decimal strings, while checkout and expiry recovery expect numbers. A valid numeric JSON response consequently refuses checkout with 502. Preserve exact integer validation and add a real-codec composition test in Claude's branch.
2. An absent transaction followed by a later finalized height beyond expiry can mark a payment failed even if it finalized between the reads. That terminal state releases resale guards. Missing receipt history must remain unresolved with inventory held until trustworthy evidence permits recovery.

Both offline reproduction receipts are retained privately under `work/release-qa/pr60-delivery-audit-20261025-head43c0b0d/`; no actual network, signatures or database writes were used. A dropped-response UI recovery concern is still a source-review lead, not a third independently verified blocker.

Sent to the existing owner thread: [PR60 review comment](https://github.com/Jesuslikex/bundle-tek/pull/60#issuecomment-6399726402). No owner files were edited or merged. PR59 pin review remains pending; full Jito read-only qualification is still refused, with the original 32-slot limit and both full code scans unchanged. OpenCode's existing usage-limited session was not restarted. This bounded Activity claim is complete; full parity is not complete.
