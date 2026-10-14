# Durable Counter proposal reservations

Source commit **57cd24b** adds server-side proposal reservation storage and atomic binding to the existing imported signing-intent lifecycle. It does not create a parallel signing state machine, expose a new signing route or enable Counter signing in the UI.

## Reservation and approval contract

The new `counter_proposal_reservations` table has one row per owner/project/plan/decision. It retains the preparation identity, wallet/revisions, packet hash, exact proposal/input/output/fee-rent limits, expiry and nullable approval pointer. The application helper validates canonical raw amounts and identities, decodes the owned plan, checks its recorded proposal and current project, and normalizes terms for idempotent retry. `reserveReviewedCounterBuy` derives the terms from the server-side native preparation/proof and checks the owned mint/precision. These helpers must never receive a client-supplied proof as authoritative evidence.

An unapproved, expired reservation can be replaced with a fresh preparation. Active conflicting requests cannot replace one another; competing requests have one winner. The original creation time survives replacement. Exact same-term retries recover the existing reservation. Owner-scoped recovery remains available after expiry or plan pause.

Database guards enforce active project/plan context, exact initial revisions, recorded proposal units, current unarchived wallet revision, verified wallet ownership and inclusion of all known owned wallets in the plan's exclusions. This excludes watch-only recipient records from signing reservations. The guards independently enforce canonical u64 strings and a valid future expiry no more than thirty seconds away using the database clock.

Approval hooks on `imported_swap_signing_intents` require `counter-signing-review-v1` for Counter preparations and verify the reserved preparation, packet hash, wallet, scope, direction/mints/mode, token target and all limits. The approval insert and reservation binding commit together. Existing shared wallet reservations and signature/state guards remain in use. A failed Counter approval rolls back its shared wallet reservation too. Appended immutable decisions may advance the plan revision without invalidating an unchanged retained proposal; paused/archived or changed context still rejects new approval admission.

Once linked to an approval, the reservation is immutable, including after cancellation or failure. Neither its pointer nor the retained approval can be deleted to make the signal reusable. Existing intent recovery owns subsequent signature/submission/receipt state. This prevents silent second approval creation for a signal; a future recovery that replaces an already approved packet would need positive proof that the prior packet can no longer execute, rather than an expiry-based reset alone.

## Schema and checks

- Actual Drizzle generation produced append-only **0077_worried_owl**, its snapshot and one new journal entry. The prior 77 journal entries are identical, and old SQL/snapshots are untouched apart from the preserved pre-existing 0068 whitespace edit.
- The real Wrangler whole-file migration command applied **all 78 migrations** to fresh disposable local D1 with an exact ledger. Final report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-ZZbabc\report.json`. No hosted SQL was run.
- Real D1 mutation tests initially exposed the platform's expression-depth limit. Boolean guard conditions were regrouped without removing checks; the final ten reservation tests pass, including races, idempotency, expiry/replacement, approval binding, cancellation retention, owner/wallet/proof/context rejection, raw amount checks and shared-wallet rollback.
- **149 selected tests across twelve files passed** in the combined final run, including existing Counter API/pricing and native signing/simulation regressions. Report: `work/release-qa/counter-reservations-final-tests-20261014.json`.
- Actual-source TypeScript, four-file typed lint and production build exited zero. Logs: `work/release-qa/counter-reservations-final-types-20261014.log`, `counter-reservations-final-build-20261014.log`.
- All **1,100 source hashes** stayed unchanged during final checks, digest `fc34167bb353deb0ad405fac7839b65c70a8f46553059374520b86ff98e16518`. Snapshot: `work/release-qa/source-counter-reservations-final-20261014.json`.

## Remaining product integration

The authenticated Counter preparation/approval routes still need to persist the server-derived preparation, invoke native review/reservation, construct the exact Counter signing-review format and require explicit user confirmation. Strict codecs, signature capture/submission, receipt recovery, current source/program admission and visible reservation/history states remain required. The application does not yet write Counter approvals through a live route. Sell, positive existing WSOL, Token-2022, other ExactOut layouts/assets and shared strategy/session limits remain unfinished. This checkpoint does not establish full Proxima parity or funded/live/browser proof.

Claude UI/protected files, CROP candidate, hosting and credentials are untouched. The two unrelated whitespace edits remain unstaged. Nothing pushed, saved as a hosted version or deployed. No user transaction was signed or submitted.
