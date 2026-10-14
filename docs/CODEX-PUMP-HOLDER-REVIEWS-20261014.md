# Durable holder reviews and reservation guards

14 October 2026. Local continuation from `c4da648`. Production remains source `11ad20b`. This checkpoint does not expose holder approval/signing through an API or UI.

## Implemented

`lib/pump-holder-review.ts` defines a complete reconstructable review containing the saved project, exact create/developer/holder input, every holder slot, per-wallet allowances, original packet/lifetime, metadata release, owner-selection bindings and a canonical context SHA-256. Validation rebuilds the packet, requires every unsigned signer, derives holder targets again from the saved distribution and observed reserve/supply, checks developer percentage and quote identity/precision, and compares all limits including inactive slots. Canonical JSON binds nested limits without dropping nested properties. The packet hash and the wider context hash have separate roles: fee/rent allowances and inactive slots are not all encoded into transaction bytes.

`lib/pump-holder-review-service.ts` persists reviews in the existing immutable `pump_launch_reviews` history. It supports owned preparation, idempotent identical-term recovery, bounded history listing, exact original-packet refresh and cancellation of the initial unsigned review. Another scope or different nested terms cannot replace an active project review. Preparation uses the complete owned funding/simulation service and the existing immutable metadata/authority policy. Caller-supplied account data or unsigned packets are not accepted as preparation inputs.

Refresh passes the original blockhash and last valid height through all preparation layers. It repeats independent funding/simulation and owned selection checks, compares all source bytes, deployment hashes, non-volume simulated state, per-wallet spending/rent/output/volume gain and all semantic accounting, then rechecks review state. The simulated volume timestamp can advance; its owner, claims/rewards, volume gain and source state remain checked. The saved observation is never overwritten to make a changed packet pass.

Signing/execution/completeLaunch remain false. There is no holder approve/register/submit action yet. Approved or signed records cannot release wallet reservations merely because browser signatures are not registered: lifetime/receipt recovery is required and remains a later step. Initial unsigned cancellation retains history and releases active reservations through the review state.

## Database boundary

Append-only `0081_pump_holder_reservations.sql` adds four triggers:

- Validate holder review scope, exact saved slot order, distinct identities and every selected holder's active owned proof/revision/Recipient role and selected-folder membership/revision on insert.
- Reject active holder/payer collisions with another launch or shared Solana execution reservation at the atomic insert boundary.
- Reject new shared swap/withdrawal reservations using an active holder-launch wallet.
- Recheck all selected holder proofs, roles/revisions and folders on approval/submission transitions, complementing the existing project/deployer/state guards.

These reservations use the immutable review's active holder list and existing state machine. Inactive slots do not lock wallets; expired reviews keep their locks until safely cancelled/recovered. No new mutable reservation table or expiry cleanup worker is introduced. The create-only history query excludes holder reviews. Holder preparation and refresh explicitly require all four migration triggers, returning 503 before preflight if they are absent.

The prior 81 SQL migration files and journal entries are unchanged. Only migration 0081 and its journal entry append. Its file is pinned to LF in `.gitattributes` because Windows `core.autocrlf=true` would otherwise change its bytes and ledger checksum on checkout. Final LF SHA-256: `65a38e9c5134d2d7fd553ac06f9eab4d5e793162779ada260221b298866289dd`. Staging caught the initial CRLF/normalized-index difference before commit; both migration runners were repeated on the final LF bytes. No remote migration was run. A future release must install the new guard migration before this feature can be enabled; code presence alone does not enable it.

## Verification

- 118 targeted tests across ten files pass on Node 24: all holder modules, independent developer-buy simulation and existing create/preflight/atomic launch route suites.
- New real-libSQL service/trigger tests cover immutable/idempotent reviews, nested-limit changes, original-lifetime refresh, one-atom quote allocation changes, both directions of shared reservation conflicts, legacy launch-payer conflicts, concurrent preparation, atomic rollback, revocation after preflight, folder/role changes at approval, missing migration, retained history and approved-but-unregistered cancellation refusal. These service tests stub the independent preflight with codec-derived observations to isolate database races.
- The existing full owned integration fixture also runs the real preparation/funding/simulation/review service stack against local libSQL and controlled RPC: release, prepare, persist, refresh original packet and cancel. The provider advertises a newer lifetime to prove the explicitly reviewed original lifetime is retained. No real wallet/provider/funded operation is used.
- Actual whole-file `wrangler d1 migrations apply --local` passes all **82** migrations on fresh disposable D1 with the final LF bytes. Terminal report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-2ZqXuH\report.json` (`applyExit=0`, `appliedCount=82`, `passed=true`), superseding the earlier CRLF-byte scratch run. The script never invokes remote D1 or Turso.
- The actual Turso migration runner also applies all 82 migrations to fresh local libSQL. Read-only verification confirms its 82 ledger entries, all four holder guards and the exact final LF migration checksum. Disposable database: `C:\Users\Julian\AppData\Local\Temp\bundle-holder-review-lf-3899e7fc04b8479884aaf7d1ac7b88bd.db`.
- Actual-source TypeScript, scoped typed lint and the Next.js production build pass on the final application source. This is not a full-suite or funded mainnet pass.

Next work: explicit holder approval, browser vault signing with exact context consent, signed-packet registration, separate submission and receipt/expiry recovery, API/UI and large-group multi-packet handling. Provider coverage, live trading proof, StonkFun execution and broader Proxima parity remain separate outstanding requirements. No UI, provider/credential, cron, push, deployment, remote SQL or real signature/submission changed. Preserve main's two unrelated dirty files.
