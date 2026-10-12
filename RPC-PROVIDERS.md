# Solana wallet holdings provider

The holdings reader requires a Solana mainnet RPC that supports complete
`getTokenAccountsByOwner` enumeration for both the original SPL Token program
and Token-2022. A provider that supports native balances may still deny these
indexed reads.

Set `SOLANA_INDEXER_RPC_URL` in the server environment. For local development,
put the URL in ignored `.env.local` and let Vite restart. Do not commit an
authenticated URL or put it in a `VITE_` variable. This setting is independent
of the browser signer and the devnet transaction provider.

Resolution order is the dedicated indexer URL, then `SOLANA_MAINNET_RPC_URL`,
then `https://api.mainnet.solana.com`. There is no automatic provider rotation.
On 10 October 2026 the official public endpoint returned HTTP 403 from the
local Worker runtime. Scalar reads from another endpoint do not establish
that endpoint supports holdings enumeration.

## Local preview verification

The earlier local configuration used QuickNode's public documentation
demo endpoint, `https://docs-demo.solana-mainnet.quiknode.pro/`. It contains no
API key. It is suitable for bounded development checks, and is explicitly
identified as a public demo in retained observations. It is not a production
availability commitment. Configure a dedicated provider before release.

The application validates mainnet genesis, confirmed context slots, wallet
and program ownership, exact integer balances, duplicate accounts, mint
decimals and inventory size. Both program reads must succeed. A failed or
partial enumeration never replaces a saved snapshot with an empty inventory.
The route rechecks active wallet revision atomically when persisting results.

To verify a configuration, open a saved public Solana address in My wallets,
choose Tokens and Refresh token holdings, then reload and reopen it. Confirm
the source hostname, slot range and inventory persist. Test an address with
nonzero token balances as well as a complete empty inventory. These reads
do not prove signing access, transferability, prices or production readiness.

Provider access denial and provider rate limits have separate user-visible
errors. Server diagnostics retain only the RPC method, hostname and HTTP
status; credential-bearing URLs and raw upstream errors are not returned.

## Jupiter and unsigned warmup verification, 11 October 2026

`JUPITER_API_KEY` is a server secret. The user created the dedicated
"Bundle Local Development" key in their existing Jupiter team. It is now
saved in ignored `.env.local`, and the local Worker restarted successfully.
Do not use a `VITE_` variable, commit the key, or include it in logs or exports.
Both live SOL-to-USDC and USDC-to-SOL quote requests returned HTTP 200.

Wallet-bound preparations request Jupiter Metis routes, a v0 transaction,
exact input and 50 bps slippage. The server rejects redirects without
forwarding its credential. Preparing an unsigned order uses no signing or
execute endpoint. Separate review and submission still require the original
packet, current block height, owned context and fresh independent simulation.

The public demo returned HTTP 429 under burst reads. For this local preview,
`SOLANA_RPC_MIN_INTERVAL_MS=1100` spaces Solana requests in each Worker
runtime. Accepted values are decimal integers from 0 to 2000; absent or 0
disables pacing. EVM reads are unaffected. Pacing has no retry or provider
rotation, and it is not an account-wide or cross-Worker rate limiter.

Live native SOL buy preparation and retained history passed through the actual
Worker API. A direct fresh unsigned settlement review also accepted exact
wrapping, canonical account setup/cleanup, observed rent, declared 2 bps fee
and pinned lookup tables. Repeated later approval simulations through the
public demo returned `BlockhashNotFound`; the server withheld approval and
created no signature. Initial simulation success is not continuing signing
clearance. The UI now distinguishes unavailable blockhashes from other failed
simulations and asks for a fresh preparation or a consistent RPC provider.

The dedicated local provider is now Helius at `mainnet.helius-rpc.com` for
both `SOLANA_INDEXER_RPC_URL` and `SOLANA_MAINNET_RPC_URL`. The user supplied
the key through the clipboard. Authentication, mainnet genesis, a fresh
finalized blockhash and blockhash validity passed. An unsigned simulation
using a generated unfunded fixture returned the expected `AccountNotFound`,
without `BlockhashNotFound`. This verifies simulation endpoint access, not
funded transaction success. Local pacing is now 200 ms. The key remains in
ignored `.env.local`, distinct from the preserved Jupiter key.

Independent genesis and context checks remain enforced. Earlier public demo
results are development evidence, not a production execution commitment.
No funded wallet, broadcast or real buy-to-sell round trip was used in these
checks.

References:

- [Jupiter portal setup](https://developers.jup.ag/docs/portal/setup)
- [Jupiter order validity](https://github.com/jup-ag/docs/blob/main/swap/order-and-execute.mdx)
- [Solana transaction confirmation and expiration](https://solana.com/developers/cookbook/transactions/confirmation)
- [Cloudflare request redirect handling](https://developers.cloudflare.com/workers/runtime-apis/request/)

References:

- [Solana getTokenAccountsByOwner](https://solana.com/docs/rpc/http/gettokenaccountsbyowner)
- [QuickNode method documentation and public demo](https://www.quicknode.com/docs/solana/getTokenAccountsByOwner)

## Helius clipboard recheck, 11 October 2026 at 10:23 UTC

The copied Helius credential matches the existing ignored local configuration
and differs from the preserved Jupiter credential. Both mainnet read and
simulation endpoints point to Helius. A fresh read verified mainnet genesis,
a finalized blockhash at slot 455616905, and confirmed blockhash validity.
An unsigned synthetic unfunded-payer simulation reached the runtime at slot
455616937 and returned the expected AccountNotFound, without BlockhashNotFound.
This does not prove a funded swap or signing success. No transaction was
signed or broadcast. Sanitized evidence is in work/rpc-qa/helius-current.json.

## Helius clipboard confirmation, 11 October 2026 at 11:19 UTC

The current copied key matches the already configured Helius credential and differs from Jupiter. The ignored local configuration needed no replacement. Fresh read-only authentication, mainnet genesis, finalized blockhash retrieval at slot 455631827 and blockhash validity checks passed. No transaction was signed or broadcast. An initial ad hoc genesis comparison used a truncated expected string; repeating it against the complete mainnet identifier corrected that check. The earlier unsigned unfunded simulation remains historical evidence, not a new simulation from this confirmation.
