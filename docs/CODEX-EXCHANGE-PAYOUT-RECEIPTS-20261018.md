# Smoke-style exchange funding: finalized SOL payout checkpoint

Local implementation only. No push, deploy, remote SQL, provider setting, credential, live exchange order, funded transaction, wallet unlock, wallet signature or broadcast occurred. Synthetic test packets are signed with deterministic fixture keys, never a user vault. Other Bundle chat owns Volume recovery and migration 0107; this checkpoint owns exchange files and migration 0106.

## What changed

The internal owned-order service can now retain a finalized native SOL payout receipt and report `payout-verified` separately from a provider's unverified `finished` status. It derives the signature, recipient and exact lamports from immutable owned review/attempt/finished-observation records. A caller cannot supply another payout signature or a receipt. Private provider IDs, quote rate references and deposit addresses stay off the public order state.

Provider observations retain canonical optional payin, payout and refund transaction references. Forward-only SQL guards prevent changing a known reference, including racing same-status observations. A later missing reference does not erase the earlier one. The receipt service refuses conflicting retained payout references, including legacy conflicting history.

The explicit injected read-only RPC collector checks mainnet genesis before and after the reads, successfully rooted signature status, finalized transaction bytes and a finalized root at or above the transaction slot. It has a 25-second deadline, cancellation checks, sanitized provider errors and no automatic retry. A 429 stops that verification attempt. No production RPC adapter or new endpoint is configured by this checkpoint.

Raw legacy and v0 packets must fit Solana's packet bound, round-trip encoding exactly and verify every required Ed25519 signature with Bundle's existing strict verifier. The primary signature must equal the retained provider reference. Lookup resolution uses finalized RPC metadata with exact address counts and unique keys.

The recipient must be writable, a nonsigner and distinct from the fee payer. Exact integer native pre/post balances must show the promised increase, while whole-transaction native conservation equals the reported fee. Decoded System transfers into that recipient must sum to the same exact amount. Direct, batched, inner transfers and fully derived TransferWithSeed are supported. Recipient outflow, unsupported System instructions touching the recipient, malformed inner coverage and missing evidence refuse verification.

The transaction must have an RPC block timestamp at or after the saved attempt and no later than server verification time. A late payout may be verified after quote expiry or draft archive; quote expiry is not treated as a payout deadline. No extra timestamp tolerance is invented here.

## Persistence and authority boundary

Migration `0106_exchange_payout_receipts.sql` adds an immutable retained receipt linked to its owned order attempt and exact finished provider observation. SQL independently binds owner, order digest, signature, funder, expected amount, time and authority flags. There is one receipt per order and a unique `(signature, recipient)` credit, so a batched transaction may pay different recipients but cannot credit the same recipient to multiple orders. Replay reads the existing owner-bound content digest without another RPC call. The digest is an integrity fingerprint, not a cryptographic authorization or inclusion proof. SQL guards do not themselves perform signature verification; that remains the trusted server verifier's responsibility.

Finality, balances, inner instructions, timestamp and loaded lookup addresses are RPC attestations. The raw packet signatures are verified locally, but this is not independent cryptographic block inclusion proof. The receipt stores a packet hash and normalized evidence, not a full raw RPC response. Unknown carrier programs are not admitted for signing or execution by this historical native-credit verifier.

Every order/payment/signing/execution authority flag remains false. `currentSpendabilityVerified` remains false. The one-attempt-per-draft hold stays in place even after a verified payout. No deposit proof, refund verification, hold-release protocol, distribution authorization, fresh spendability/rent check, live provider contract qualification or funded end-to-end proof is delivered here. The existing quote UI is unchanged; there is no new live order/payout API or approval interface yet.

## Verification

- Pinned Node 24: six exchange/quote/API/UI test files, 188 tests passed. This is targeted verification, not a full-suite claim.
- Signed synthetic packet tests cover direct, batched, inner, lookup and seeded payouts; exact large integers; wrong network/finality/time/amount/recipient; invalid signatures; correctly signed unsupported System instructions, nonsigner sources, recipient spending, readonly/duplicate accounts and wrong seeded derivation; missing inner/lookup evidence; cancellation and first-429 stop.
- Actual in-memory libSQL order/receipt tests cover owned context, no-signature finished state, omitted and changed provider references, historical reconciliation, immutable retention, duplicate order credit refusal, safe failure and unchanged payment authority.
- Plain TypeScript, scoped typed lint and formatting passed. Combined Next.js webpack production build passed with the other chat's frozen Volume changes present. Existing external parent lockfile warning remains.
- Disposable local Turso: all 108 migrations applied, 605 schema objects. Other Bundle chat verified the same frozen chain through whole-file Wrangler (108/108) and Miniflare/SQLite. None of these checks touched hosted databases.
- Restored the existing guarded local HTTPS app after the shared build: sign-in returns 200 and a synthetic forbidden submit request returns 403 before forwarding. No new rendered UI or authenticated production check is claimed for this backend-only checkpoint.

Official RPC contracts: [getTransaction](https://solana.com/docs/rpc/http/gettransaction), [getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses), [getSlot](https://solana.com/docs/rpc/http/getslot). `getTransaction` uses finalized commitment; the subsequent finalized `getSlot` applies its transaction-slot floor. No unsupported `minContextSlot` parameter is sent to `getTransaction`.
