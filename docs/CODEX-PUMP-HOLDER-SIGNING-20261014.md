# Explicit holder approval and local all-wallet signing

14 October 2026. Local continuation of review checkpoint `7adc065`. Production remains source `11ad20b`. No migration, deployment or real wallet action is part of this change.

## Behavior

`lib/pump-holder-signing.ts` requires consent to the exact review ID, packet SHA-256, full context SHA-256, complete launch scope and all listed simulation limits. Its browser-local signing primitive reconstructs the entire review, requires exactly the deployer/mint/active-holder signer set and checks every vault seed/address identity before creating the first signature. Inactive holders do not sign. Multiple selected wallets may share one decrypted vault session, but each address must have exactly one matching entry.

The caller must supply a live UI-context guard. It is checked around asynchronous review validation, key prevalidation, each signature and the final return. Expired or changed reviews produce no returned partial packet. Temporary seed and private-key byte arrays are cleared with `finally`; the caller still owns and must lock/clear its decrypted vault sessions. The primitive has no RPC, fetch, clipboard or storage operation and does not submit anything.

Strict signed-packet verification requires canonical bounded base64/transaction serialization, the exact reconstructed message and every required strict Ed25519 signature. A missing/corrupt signature from any wallet, changed message, suffix bytes or noncanonical encoding is rejected. Verification of an expired saved signed packet is allowed for history/recovery; generating new signatures still requires a live review.

The holder review service adds two server operations:

- Explicit approval repeats complete original-packet funding/simulation and context refresh, then atomically changes the review state under the existing ownership/project/reservation guards. Repeated approval refreshes again. Only a live approved row reports `signingAllowed=true`.
- Signed-packet registration requires the same exact consent and verifies all signatures before retaining the packet. Re-registering the identical packet is idempotent. Registration makes no provider call, does not refresh/change the saved packet and never broadcasts. Expired signed packets or signatures whose holder proof was subsequently revoked can still be retained for recovery; this does not permit submission.

Approved/signed reviews retain their wallet reservations. Initial unsigned cancellation does not release them. Separately consented submission, finalized/expiry recovery, HTTP routes, browser UI and larger multi-packet groups remain unfinished. `executionAllowed` and `completeLaunch` remain false, and nothing has been connected to a live user signing action.

## Verification

135 targeted tests across eleven files pass on the final application source using Node 24: all holder modules, independent developer-buy simulation and existing launch route regressions. Actual-source TypeScript, six-file typed lint and the Next.js production build pass. This is not a new full-suite or funded mainnet pass.

The signing fixtures use generated synthetic browser vaults. They cover all active identities, inactive exclusion, complete prevalidation, mismatched consent/context/scope, wrong/ambiguous vault entries, cancellation, expiry after the last signature, erasure of temporary private bytes, strict packet/message/signature tampering and expired recovery verification. Native and stock holder-only packets are reconstructed and signed with the exact quote context. No real vault or private key was read.

The database tests cover explicit approval, re-approval refresh, foreign ownership, consent mismatch, unapproved/unsigned registration, idempotent signed history, proof revocation at the final approval write and retaining expired signatures for recovery. The full owned local libSQL/controlled-RPC fixture also runs release/preparation, funding, simulation, durable review, explicit approval, real verification of all synthetic signatures and registration. Its simulation count proves registration triggers no new simulation/provider action. No real provider, funded launch or network submission is used.

The existing 0081 guard migration is unchanged and still requires separate application before a future production holder release. Earlier local 82-migration verification is documented in `CODEX-PUMP-HOLDER-REVIEWS-20261014.md`; no migration runner or hosted SQL is invoked here. No UI/Claude-owned file, provider/credential, cron, push or deployment changed. Main's two unrelated dirty files remain preserved.
