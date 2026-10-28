# Jito signing reservation draft

This is a local, non-deployable draft for durable Jito signing attempts. The
existing browser client does not yet use the v2 protocol: deploying the API or
applying migration 0163 before integrating the client would interrupt the
current signing flow. Keep this work on a draft branch until the complete flow
and migration numbering are checked together.

The draft records an immutable owner, bundle, packet, signer, manifest digest
and attempt identity before opening a wallet. An unresolved attempt is held as
unknown. Retrying the same attempt after a lost response does not authorize a
second wallet prompt. Exact signature registration is verified on the server;
the database atomically applies the verified receipt to the intent and packet.
Linked bundle and wallet reservations cannot be released while an outcome is
unknown. Historical bundles without the v2 protocol remain quarantined rather
than being assumed unsigned. This is not proof that a wallet never signed, nor
does it prevent already-open older clients from signing bytes they obtained
before an upgrade.

The standalone browser attempt adapter validates the authenticated response
against the exact expected identity and issues a single-use local signer permit
only for a newly inserted attempt. A lost response and all later reads remain
recovery-only. It is not connected to a wallet or UI; its caller must hold the
journal lock, enforce the current consent and context, and independently verify
any recovered signed packet.

Local verification of the frozen migration and server draft: 145 tests across
12 focused Jito files; 10 local engine/schema tests covering D1, SQLite and a
Turso-compatible local engine; and the complete 162-migration chain through
Wrangler's whole-file local migration command. TypeScript and scoped typed lint
also passed. The independent one-shot adapter and journal tests passed 43 cases.
These are local synthetic checks; they are not a funded or hosted proof.

The detached exact-bundle snapshot validator binds server evidence to the
signed-in owner and reviewed manifest. It preserves legacy records as read-only
and does not turn a missing historical finalization receipt into proof.
Callers must independently verify the exact signed packet before using any
registered attempt. Nine focused snapshot tests pass.

The shared warmup external signer now requires a currently published Wallet
Standard account with the exact reviewed public-key bytes. It no longer writes
wallet diagnostics to page globals or treats an empty account list as proof.
This is a deliberate compatibility change: a provider that leaves the account
list empty, including some Phantom configurations, cannot sign through this
path until it can provide a verifiable current account. A returned exact packet
is retained before an account-change error, never automatically submitted.

An evidence-only journal helper can retain an exact already-signed recovery
packet, including after expiry, only against an authenticated matching UNKNOWN
attempt. It checks the original attempt before and after storage and does not
grant a signer permit or submit authority. Its caller must enforce the same
owner lock and authenticate the exact server snapshot. Thirty-eight journal
tests pass. A separate recovery-file panel has 13 synthetic tests, including
lost-response recovery and unresolved-memory guidance. It is not yet connected
to the parent and depends on the parent supplying authenticated exact snapshots.

Still required before a release: integrate the encrypted local journal and
owner-scoped server attempt with every browser signing, import, registration,
cancel and submit path; preserve separately unchecked approval; test rejected
wallet prompts, lost responses, concurrent tabs, reloads, storage failures,
stale context and exact receipt recovery; design legacy settlement and a
controlled old-client rollout; repeat migration and full-flow checks on the
final committed source. A local or cross-device unknown must never grant a
retry or release by itself. Migration 0163 is a draft number and must be
rechecked against the target branch before merge.

No deployment, hosted database migration, provider or credential change,
funded transaction, real-wallet signing, or live bundle submission is
authorized or implied by this draft.
