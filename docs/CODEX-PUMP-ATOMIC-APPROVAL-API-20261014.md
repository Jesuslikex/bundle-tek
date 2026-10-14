# Atomic Pump approval and execution API

Added authenticated same-origin `GET/POST /api/launch/pump/initial-buy` for owned create/developer-buy reviews. Strict bounded requests cover prepare, explicit approval, signature registration, separately approved submission, read-only receipt recovery and cancellation. Preparation requires the saved project/release/deployer and separate exact quote and SOL fee/rent caps. The existing durable review, reservation, authority and refresh guards apply.

Approval and submission each require the exact packet fingerprint, `approved=true`, the explicit `create-and-developer-buy` scope and acknowledgment of simulation limits. Responses disclose that holder buys are absent, program deployment observations cover metadata only and buyback allocation rounding remains unattested. The API does not imply a complete bundled launch. Approval re-simulates the original packet before the immutable database transition; signature registration requires both strict exact-message signatures and does not send anything.

Submission rechecks the saved signatures and refreshes the original packet, costs and state, persists `submitting` first and performs one explicit send with preflight enabled and retries disabled. A lost response remains `submitting`; repeated submission requests do not resend it. Recovery checks the mainnet genesis and retrieves finalized receipts with transaction version 1 support, matches the exact stored packet/signature and records success/failure. Cancellation after approval retains reservations until finalized height has exceeded the original lifetime plus the safety margin and the mint is absent. An unapproved review can be cancelled immediately.

Signed-packet verification now permits expiry only for signature registration/receipt recovery; reconstruction, canonical packet/message checks and both signatures remain required. New signing and approval still reject expired reviews. Atomic history and actions are separated from the existing create-only flow so its UI cannot accidentally interpret or approve an atomic review.

## Verification

Five focused files passed, 57 tests, with Node 24. Real route/local D1 tests exercise the complete controlled approval, two-signature registration, distinct submission and version-1 finalized receipt flow for native SOL, SPL stock and Token-2022 stock quotes. They also cover unauthenticated/foreign-origin/bounded request rejection, explicit scope/limits consent, owner isolation, revoked payer proof, reservations, immutable reviews and no resend after a lost response. Expired signed recovery and existing create-only route/review regressions pass. Actual-source TypeScript, scoped lint and production build passed.

All signatures and sends in those tests use synthetic wallets and the controlled RPC fixture. No actual RPC send, wallet connection, funded launch, remote migration, cron, provider/credential change or deployment occurred. Claude's UI files and unrelated main work were preserved.

## Remaining

The backend is connected, but the atomic review UI and browser vault signing controls are still absent. This API is local and not deployed. Holder buys, scheduling, StonkFun execution, full code/rounding attestation and funded user verification remain open. Production remains source `11ad20b` at https://bundle-tek.vercel.app/.
