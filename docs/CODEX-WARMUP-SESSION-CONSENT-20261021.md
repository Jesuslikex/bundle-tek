# Exact retained warmup session consent

21 October 2026. Internal storage foundation following4ad947a. This is one part of durable session control, not a working automatic warmup flow.

## Stored agreement and boundaries

`lib/wallet-warmup-session-consent.ts` prepares exact terms for a separately requested plan approval, then saves them only with an explicit true approval and the same SHA-256. The terms bind the owner-scoped retained review ID/hash, its exact immutable document (ordered actions, captured wallet revisions, schedule, dependencies and original per-wallet spending/reserve limits), and an explicitly selected session deadline. The deadline must be canonical ISO and strictly follow every captured scheduled action. No schedule is rebased and no default deadline is inferred. Changing the deadline changes the terms hash and requires a new review.

Saving a review is still not consent. Saving this consent is still not a transaction authorization: executionAllowed, signingAllowed and automaticExecutionAllowed are all false in code and database rules. There is no API/UI caller, browser scheduler, wallet reservation, new signer or send. The selected session deadline records the requested end time only; it does not extend the original preview or any signing/order lifetime, nor establish a qualified maximum runtime policy. Per-action budget reservations and durable progress are not implemented by this table.

New consent must be inserted inside the source review's unchanged60-second lifetime. The service checks time again immediately before insertion; database rules also require the original source review to remain fresh at actual insertion time. Recovery reads and same-ID idempotent calls can return an existing historical consent after expiry/archival without approving anything new. A later execution layer must independently classify the deadline and current ownership/state; reading an old agreement is never permission to resume.

## Durable storage and races

New source-only migration `0122_wallet_warmup_session_consents.sql` adds an immutable owner-scoped table with a foreign key to the original review and unique(owner,review_id). INSERT OR REPLACE cannot replace an agreement. UPDATE and DELETE refuse. Direct SQL activation flags refuse. A new consent reuses the original review's insertion-time plan/wallet/revision/reservation/receipt-baseline predicates, including all stored remaining-unit counters and receipt documents. They run atomically with insertion, not solely as a read-then-write service check. Existing migrations are unchanged; journal now ends0122 and next free number is0123 subject to recheck.

The service independently replays the original cryptographic review decoder, binds the raw parent source/document before and after that read, validates exact terms and the stored digest again on recovery, and never accepts a request-body owner. A future authenticated server caller must supply its verified session owner. There is no authentication wrapper yet. One approval per retained review prevents competing tabs from creating different agreements for the same snapshot, but does not claim to serialize future action execution or reserve a shared wallet across sessions.

A lost insert response recovers only the original consent ID with a separate bounded observation signal; it never issues a replacement INSERT. The same ID with different terms refuses. An unresolved write returns recovery guidance. Cancellation before insertion prevents the operation; an already committed agreement may still be recovered after cancellation, with all capabilities false. No private key, signature, provider request or credential is involved.

## Verification

Final **241 tests across13related files pass**, including24 new consent cases using disposable in-memory libSQL and the real Turso/D1 adapter plus the actual0117/0122 SQL. Minimal parent schemas match the columns/joins under test; this does not claim full historical app-schema composition for every test. Cases cover exact action/budget/deadline capture, separate unchecked approval, changed hashes/deadlines, request field rejection, cross-owner isolation, deadline/order bounds, expiry and last-moment expiry, historical recovery, duplicate identities/reviews, competing same/different-ID requests, lost-response recovery, insertion-time plan/wallet/receipt/shared-reservation races, SQL authority bypass, immutability, corruption, cancellation and missing guards. Fetch is forbidden in the new cases.

Whole-project plain `tsc --noEmit --incremental false`, two-file typed lint and formatting pass. An initial TypeScript narrowing failure in the new helper was corrected with an explicitly declared never-returning failure function before the final checks.

The unchanged checksum runner applies all123 migrations to a new disposable local file database. The real whole-file Wrangler command also applies all123 files and verifies its exact ledger (scratch `bundle-wrangler-migrations-vTwNGx`, exit0). No application or hosted database was read or migrated. No new build/browser, real-provider, production or funded proof is claimed for an unmounted server library. REA's approved9223 endpoint remains unreachable, so no fresh Proxima runtime evidence is claimed. A read-only Opus5.5 review will target the committed checkpoint; no review result is implied yet.

## Remaining integration

Next: durable action identities and atomic budget/reservation transitions, exact receipt-backed crash/unknown recovery, a qualified finite session lifetime policy and fresh per-action authorization, authenticated API and explicit unchecked consent UI, then a browser scheduler with pause/stop/reload recovery. The existing in-memory sequencer still enforces its original preview deadline; this consent table does not relax it. Automatic Start remains off. Broader Proxima parity, alternative routing, provider qualification and separately authorized funded proof remain unfinished. No deployment or provider/credential/cron change occurred.
