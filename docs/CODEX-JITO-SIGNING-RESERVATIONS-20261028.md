# Jito signing reservation draft

This is a non-deployable draft for durable Jito signing attempts. The draft
browser client now uses the v2 protocol, but old clients and historical
records need a controlled rollout and recovery plan. Keep the work on a draft
branch until the complete flow and migration numbering are checked together.

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
recovery-only. The draft client uses it under the journal lock; the caller must
enforce current consent and context and independently verify recovered packets.

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
lost-response recovery and unresolved-memory guidance. In this draft it is
connected for bundles shown in the recent history, with additional parent and
panel tests. A separate older-bundle locator validates a bounded recovery file
and two owner-scoped exact reads, with 15 synthetic tests including deadline
expiry during verification. In the draft it is connected to the parent and
keeps the recent 20 records intact. Users reselect the file in the packet panel
and separately approve any evidence registration. See
`CODEX-JITO-V2-OLDER-LOCATOR-20261028.md` for synthetic checks and limitations.

The draft browser wiring supports the browser vault and external wallets that
publish a verifiable current account. It holds the owner lock around signing
and exact recovery, and keeps a separate unchecked evidence approval. Synthetic
tests cover remounts and external account changes; real browser extension and
provider behavior remain unverified. The existing 65-case remount suite has
been migrated to v2 without skipping or deleting tests. All 65 passed within a
222-test combined synthetic run whose source hashes were unchanged. See
`CODEX-JITO-V2-remount-inventory-20261028.md` for intentionally changed
expectations and remaining limitations. This branch must not be merged or
deployed as a completed flow before whole-project, browser and rollout checks.

The signing panel now distinguishes preparation before a signature is
requested, the wallet response, local retention and registration, and its
evidence-only recovery steps. Thirty-eight focused child tests pass, including
delayed-stage checks; these are synthetic and do not prove a real wallet flow.

A separate terminal-bundle panel verifies an owned signed file and offers
explicit private export only, without registration, signing or submission.
Its 17 synthetic tests cover the owner lock, stale context and terminal state;
it is connected to the parent in the draft but has not been checked as a real
browser download. Missing historical receipts are not treated as proof of
finality; an expired label alone is not proof that a packet did not land.

Signing, recovery and submission controls also reject stale callbacks and
revoked or replaced consent. Changing a signing password clears its approval.
The server, journal and exact owned receipt checks remain authoritative; these
UI guards do not prove that an unknown wallet outcome was unsigned.
Matching history alone no longer clears a retained in-memory signed packet.
The active owner-locked paths acknowledge memory only after exact server
receipt verification and durable journal acknowledgement; failures retain the
packet for recovery. Five focused synthetic suites passed 144 tests.
If a journal acknowledgement committed but the screen changed before the
memory copy was acknowledged, an explicit, initially unchecked action can now
reconcile it against repeated owner-scoped exact registered receipts and the
same packet. A missing journal alone never grants a signing or submission
action. The expanded five-suite recovery run passes 150 synthetic cases.

Still required before a release: verify integrated journal and server behavior
in a real browser with separate approvals, concurrent tabs, reloads, storage
failures and exact receipt recovery; design legacy settlement and a controlled
old-client rollout; and repeat migration and full-flow checks on the final
committed source. Old open clients can already possess signed or unsigned
bytes, and applying 0163 can quarantine historical records and make an old
code rollback incompatible with the new guards. Back up and rehearse recovery
before any future migration. A local or cross-device unknown must never grant
a retry or release by itself. Migration 0163 is a draft number and must be
rechecked against the target branch before merge.

The existing sequential simulation check is diagnostic and does not authorize
submission. The internal one-send function does not yet require a fresh full
same-bank qualification of the exact signed vector. The draft API route now
returns 409 before database or sender work for every submit request, and the
UI disables submission with a visible explanation. Repository search found no
other non-test caller of that internal function at this checkpoint; the route
gate is not a guard inside the function itself. Wiring and proving the full
qualification is an outstanding release blocker. Individual packet
simulations do not establish the requested sequential-bundle evidence.
An unmounted signed-vector evidence constructor now verifies each registered
swap and tip signature and binds the ordered exact bytes to the owner and
bundle. It grants no source, provider, runtime, signing or execution authority;
future use must authenticate its input and recheck mutable bytes at the final
boundary. Its focused tests and the snapshot tests pass 17 synthetic cases.
An additive signed economic replay passes those exact signed packet bytes into
the existing frame and economic checks while leaving the unsigned API intact.
It does not authenticate a provider request, response, baseline or runtime
capture, and grants no provider or execution authority. Five focused suites
passed 201 synthetic tests.
An unmounted offline Clock/lifetime decoder checks exact Clock equality, the
30-second wall-time bound, duplicate reads, network values, blockhash validity,
conservative expiry and the original 32-slot span. It copies bounded raw bytes
before asynchronous work and rejects shared-backed buffers. It explicitly does
not authenticate caller-supplied data or authorize submission; trusted direct
provider capture and a final signed-vector gate remain to be built and proven.
An unmounted DB-only reader now checks a registered vector against exact
receipts, both reservations and current project, session, preparation,
acquisition and fee data. A real-reader synthetic SQLite sell test covers
stale receipt, session, wallet and project refusal. The process-local handle
retains a bounded hash, not packet bytes. Its caller still must authenticate
the owner; repeated reads are not an atomic database snapshot and do not grant
provider, currentness, signing or execution authority. Four focused suites
passed 29 synthetic tests.

No deployment, hosted database migration, provider or credential change,
funded transaction, real-wallet signing, or live bundle submission is
authorized or implied by this draft.
