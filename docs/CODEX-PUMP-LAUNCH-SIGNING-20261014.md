# PumpFun create-only launch and signing checkpoint

14 October 2026. Local implementation and verification only. Nothing pushed, saved as a hosted version, deployed, signed with a real funded wallet or broadcast to a network.

## Implemented flow

The existing PNG/JPEG private upload and explicit public metadata/image release feed a saved PumpFun launch. The exact selected quote mint is retained, including catalogued tokenized-stock assets, subject to the live Global/QuoteControl and mint-extension checks already in the Pump builder. Stock labels do not establish issuer identity, backing or redemption rights.

A project-specific new mint key is generated and encrypted in the browser using the existing AES-256-GCM/PBKDF2 vault. The user can download and restore its encrypted backup. A browser lock prevents replacing an existing project mint. The payer must be the saved, ownership-verified Solana deployer and must exist in the browser vault. Passphrases/private seeds never enter API requests. Sessions are cleared after signing attempts.

Authenticated POST /api/launch/pump supports prepare, approve, register, submit, recover and cancel. GET returns owner/project-scoped recent history. Requests are bounded, same-origin and strict-field checked. The new append-only 0079 migration stores immutable review terms, exact unsigned and signed packets, separate approval/submission states and finalized receipt evidence. Active project/mint/payer constraints plus reciprocal shared-wallet reservation guards prevent competing application execution with the same payer. Database guards recheck saved project, payer revision/proof and folder state atomically before approval/submission. Previous SQL is unchanged; the unrelated pre-existing 0068 whitespace edit is excluded.

Before signing, the browser reconstructs the packet from the reviewed identity, metadata URI, configuration and quote accounts. Both payer and new mint signatures cover that exact message. The server verifies both signatures. Approval and broadcast are different explicit actions. Approval and submission resimulate the original blockhash and exact packet rather than replacing its lifetime. The allowance caps native fee/rent debit at an explicitly chosen amount no greater than 1 SOL. Immutable metadata is required; any retained mint authority must be Pump's derived mint-authority PDA.

Submission records `submitting` before the RPC call, uses preflight and zero RPC retries, and does not automatically resend after a lost response. Recovery checks mainnet finalized transaction bytes against the saved signed packet before reporting success/failure. A missing receipt releases the reservation only after finalized height exceeds the packet lifetime plus a margin and the new mint is absent. Ambiguous outcomes remain reserved. The browser saves a signed packet locally before registration and can retry registration without generating another signature.

## Verification

- 91 targeted tests across 13 files passed, covering real route/local D1 state transitions, both SOL and TSLAX quote fixtures, exact dual signatures, encryption/restore, changed context, shared reservations, atomic folder guards, mismatched finalized packets, uncertain submission, metadata/image persistence and separate UI approvals. Report: work/release-qa/pump-launch-signing-final-20261014.json.
- Actual-source TypeScript, 19-file type-aware lint and production build passed. Build log: work/release-qa/pump-launch-build-20261014.log.
- The real whole-file Wrangler command applied all 80 migrations to a fresh disposable database. Evidence: C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-HrCBJ0/report.json. No hosted SQL was used.
- All 1,134 source files remained unchanged through final verification. Snapshot: work/release-qa/source-pump-signing-final-20261014.json. Digest: d2da9874f766cf159af428adafe4a93eb2a8f801e81d848702b6ed85f7bbf5e0.

## Exact limits and next verification

This is **create-only**, not an atomic create-plus-initial-buy launch. Saved developer/holder buys or scheduling are rejected, and the UI offers an explicit draft edit to zero them before resaving. Unsupported rewards/options remain rejected by the builder. StonkFun execution and external Wallet Standard payer signing are not implemented here.

The funded mainnet path has not been proven. Live program implementation/authority behavior and any changes to quote admission can still cause simulation to reject the launch. Program executable/header stability is checked, but it is not a full program-bytecode audit or upgrade-authority guarantee. Synthetic tests are not evidence of on-chain execution. The original hosting ownership mismatch and CROP's unresolved migration state are unchanged. A stable HTTPS origin and working private RPC are required before real metadata publication and launch use. Image persistence depends on continued hosting.

Official protocol reference: https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/instructions/COIN_CREATION.md . The pinned create_v2 account layout remains the builder source. Initial buy composition is deliberately outside this transaction and must not be inferred from a successful create-only result.
