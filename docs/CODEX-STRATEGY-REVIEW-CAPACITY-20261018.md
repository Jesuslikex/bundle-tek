# Shared strategy review capacity, 18 October 2026

## Problem and scope

The live Proxima evidence retained by `CODEX-STRATEGY-SESSION-DRAFTS-20261018.md` distinguishes optional strategy stops from a shared session stop. Local `c19f618` saved those terms but had no durable capacity accounting. Multiple candidate reviews could therefore have no shared, recoverable claim on the draft's input limit.

This checkpoint adds persistent **review capacity**, not a financial reservation or active strategy executor. It claims only a saved draft's declared input caps. A held slot can precede its scheduled start and does not prove that a Limit condition matched. It never locks wallet funds, assesses current spendability, creates a transaction, consumes a real trade, or authorizes signing/submission. All financial authority flags remain false at model, SQL, API and client boundaries. This distinction is necessary: future execution must add its own global wallet reservations and receipt-backed accounting rather than treating these unsigned slots as money held.

## Behavior

- A saved draft offers an explicit, initially closed **Review shared budget** panel. Opening reads current stored state without creating a record. The first successful claim creates one ledger bound to that exact owned draft and immutable plan hash.
- DCA cycle and Limit candidate inputs come from retained terms, never client-supplied amounts. Each candidate can have only one active slot. Shared and independent caps use integer atoms, including token amounts above signed SQLite integer precision. Missing caps stay absent.
- Claims preserve their schedule and effective deadline. Candidates at or after a deadline are refused. The server also checks the database clock strictly before the effective deadline at the actual SQL write. No start/deadline slides on retries.
- New claims atomically recheck draft archive/revision/hash, current project revision/full observed document and every captured wallet's active revision. Compare-and-swap ledger revision and checksum serialize competing requests; a loser must reload instead of silently retrying against a changed budget.
- Requests retain IDs across ambiguous cancellation/retry. An existing ID returns its retained state, including after release, without reclaiming capacity. Only a new explicit request can claim a released candidate again. There is no attempted/signed/submitted/settled state or mutation action.
- Releasing an unsigned slot frees capacity once. Archived or changed wallet/project contexts can still read history and release unused review slots. Holds never disappear automatically because of timeout, browser close, deadline or archive.
- SQL preserves ledger identity, plan hash and history. Updates increment revision exactly once, append one held row or release exactly one retained held row, and cannot drop/rewrite old terms or reactivate released records. Deletes are refused. History is bounded to 1,000 slot IDs; the user can save a fresh draft copy when full. At most 200 distinct finite candidates can be active.
- The UI shows shared and per-strategy claimed/remaining caps, blocks an already-held or known unaffordable selection before mutation, and gives an explicit reload path after ambiguous writes/errors. Context changes cancel pending work and hide cached capacity. Released history stays collapsed and renders the newest 20 records while older records remain stored.

Migration 0110 and its schema/journal entry are local only. Existing connected/hosted databases have not been migrated by this work. Missing storage produces an actionable error, not a fabricated empty ledger.

## Verification

- Final focused selection: 14 files / 174 tests passed, including both strategy draft and capacity flows, actual production Turso adapter/SQLite triggers, authenticated API Request/Response tests, mounted React controls, exact planning arithmetic, request deadlines and existing DCA/conditional/parent/DurationInput regressions. Not a full repository suite.
- Storage cases cover competing writers, root/individual caps, stale revisions, exact SQL-time wallet/project/draft changes after application reads, database-clock refusal with a stale application clock, explicit releases after archive/context changes, retained-ID retries and u64 token input round trips.
- UI tests cover explicit loading, reserve/release/new claim, ambiguous cancellation with the same ID and ignored late response, context invalidation, archived/locked release, foreign/modified authority/totals and a pre-request exhausted-cap explanation. Mounted UI hashing uses Node's real SHA-256 synchronously to avoid native WebCrypto scheduling nondeterminism; service tests and browser checks use actual WebCrypto.
- Standalone TypeScript, final scoped typed lint and formatting checks passed. The React checklist prompted moving integer comparison into a pure helper rather than suppressing the compiler's capitalized-call diagnostic.
- Actual component + built product styles + actual capacity/draft services were checked in the Codex browser against disposable in-memory SQLite, synthetic owner and public fixture addresses. DCA claim blocked a competing Limit; release/reload admitted the Limit; hard reload retained it; archive preserved release; restore allowed a fresh claim. The final UI disables an exhausted selection with a reason. Widths 320/375/1440 have client/scroll widths 305/305, 360/360 and 1425/1425. Ignored proof: `work/release-qa/strategy-capacity-mobile-20261018.png`. This is not a real-account or provider/funded acceptance claim.
- Full-file Wrangler applied all 111 files with exact 111-entry ledger match. Receipt: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-pP75XM\report.json`; 0110 SHA-256 `c641410167e0cd9da6aa3677a780ddea973c79b610364976aef1068a717a7e7b`. Independent whole-chain SQLite/Miniflare schema test passed (13.61 seconds). No hosted SQL.

## Build and handoff

Combined production build completed with exit 0 on frozen strategy-capacity and the other chat's separate launch-layer UI sources: webpack compilation 35.6 seconds, TypeScript 48 seconds, static generation and traces completed. That chat removed its three temporary public fixture files before the build; their directory remains absent. Existing trusted local HTTPS was restored at `https://localhost:3443`; sign-in returns 200 and anonymous capacity API returns 401 with `cache-control: no-store`. No TLS bypass, provider change or real-account write.

The other Bundle chat independently read the pure model, server and 0110 SQL and found no blocking issue in these draft-only semantics. It confirmed that integer totals are enforced by server validation plus atomic compare-and-swap, while SQL additionally enforces structural/history rules. This is not a database-only solvency proof or a global cross-draft financial budget. Its independent core rerun passed 25 tests in two files.

The local checkpoint stages only 19 owned strategy files/hunks, including 0110 and its schema/journal entries. Layer UI, its model/client changes and matrix/verification notes remain separately owned and unstaged for that chat. Ignored temporary fixtures, captures and runtime data are excluded. Local commits do not publish or migrate any hosted database.

## Remaining parity requirements

This is an additional accounting foundation. Live condition/price validation, quote/simulation/program admission, ownership proof, fees/rent/slippage policy, globally coordinated actual wallet reservations, immutable prepared transaction review, per-transaction user approval and receipt-backed consumed input/settlement/recovery must still be joined before any financial execution can be enabled. Continuous and broader strategy types, wallet subsets, other quote assets/venues, hosted acceptance and funded user-performed proof remain open. Full Proxima parity/superiority is not established, and the overall goal stays active.

No funding, vault unlock, private key access, transaction/signature, provider or credential change, push or deployment. Concurrent Claude token UI remains preserved and unmerged.
