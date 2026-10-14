# Atomic Pump packet signing and verification

Added a local version-1 create/developer-buy signing primitive and an independent signed-packet verifier. A review reconstructs the complete packet from encoded creation observations, the exact token output, quote-spend cap and resource configuration. The saved developer percentage must resolve to that output using the observed token supply. Unexpected atomic options, unsupported transaction versions, expired reviews and fee/rent allowances above 1 SOL are rejected.

Signing requires explicit consent naming the exact review ID and packet fingerprint, the exact unlocked payer and mint vault wallets, and a caller-supplied current-context guard. Review data is cloned before asynchronous reconstruction. The guard is checked again around signing and expiry is rechecked afterward. Temporary seed/private-key bytes are cleared; each generated signature is independently verified using the strict canonical prime-order Solana verifier before returning it.

Signed-packet verification reconstructs the approved unsigned message, requires canonical base64 and transaction re-encoding within the version-1 4096-byte packet limit, compares the complete message and verifies both exact signatures. Missing signatures, altered instructions, trailing bytes and high-S scalar variants are rejected. No RPC, approval persistence or submission is performed by these functions.

The existing create-only encoded-account decoder was extracted without changing its checks so both review formats use the same decoding. Existing create-only signing behavior is otherwise unchanged.

## Checks

Six focused files passed, 32 tests: synthetic native and stock dual signing, exact consent, changed supply targets/caps/metadata, expiry/allowance/version rejection, wrong keys, context changes, missing/malleable signatures, changed messages, trailing/oversized packets and degenerate signing identities. Existing create-only signing, message, route and review component regressions passed. Actual-source TypeScript, scoped lint and production build passed.

Only synthetic test vaults were signed. No real wallet connection, private key export, funded simulation, transaction submission, remote SQL, cron, provider change or deployment occurred. Claude's UI files and main's two unrelated dirty files were preserved.

## Integration still outstanding

This is a signing primitive, not a complete approval policy. No live API/UI imports it yet. The durable owned review must bind independent simulation evidence, quote/rent reservations, project and wallet revisions, authority policy and fresh original blockhash validity before signing can be offered. Submission must remain separately approved with version-1 receipt recovery. Buyback split rounding remains unattested in the collector. Holder buys, StonkFun execution and funded user verification remain outstanding. Production remains source `11ad20b` at https://bundle-tek.vercel.app/.
