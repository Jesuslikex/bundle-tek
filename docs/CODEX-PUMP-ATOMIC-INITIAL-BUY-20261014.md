# Pump atomic creation and developer buy

14 October 2026. Source construction checkpoint. The full Proxima goal remains incomplete; this change is not enabled in the launch API, signing review or UI.

## Implemented

`lib/pump-initial-buy-message.ts` builds one unsigned transaction containing the existing pinned `create_v2`, idempotent developer base-token ATA setup, optional stock-quote buyback-recipient ATA setup, and official `buy_v3`. The exact base-token output and maximum quote debit are canonical positive u64 strings. Partial fill is disabled. The amount must leave tokens on the curve; completing/migrating a curve is a separate path. The only required signers are the payer and new mint, and both signatures remain empty.

The `buy_v3` instruction/account order and discriminator are pinned in `pump-initial-buy-schema.json` to Pump's official IDL commit `639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22`, SHA256 `7616681ea557975f9f623ac211080f22a93060781eaf4765b0a488d980997207`. Fees still require independent live reconciliation; a matching IDL is not proof of server behavior or deployed-program equivalence.

The default packet is transaction version 1: all accounts inline, a 4,096-byte bound, explicit compute limit 1,400,000, loaded-account limit 64 MiB, and absolute priority fee zero. ComputeBudget instructions are omitted in this format. These are construction limits for subsequent simulation, not measured operational resource estimates. `@solana/kit-v1` aliases the pinned official Kit 8.5.0 package for this path; the existing Kit 7.1.1 stack and its peer dependencies remain unchanged.

A separately selected version 0 construction remains bounded to 1,232 bytes. It accepts at most four independently supplied active lookup-table observations, validates raw ALT metadata/owner/slot consistency and activation, retains observation hashes, and rejects oversized packets instead of dropping instructions. Same-slot extensions are excluded until active. `pump-launch-lookup-discovery.ts` performs bounded public-history discovery with cancellation, mainnet checks and independently read table accounts. Its output is sampled discovery, not complete coverage or permission to execute. Fresh tables must be recollected and revalidated by any future preflight/signing path.

`lib/pump-initial-buy-preparation.ts` composes the developer buy from an owned active saved project using the existing exact artwork/metadata/quote/supply validation. A saved 5% developer allocation means exactly 5% of program-configured total supply, never 5 SOL or 5 quote tokens. The helper uses decimal rational arithmetic, rejects fractional base-token units rather than silently rounding, and separately requires an explicit quote-token maximum. Caller-supplied token-amount overrides are rejected. Project state is checked before and after construction. Scheduled execution is rejected. Requested holder amounts are retained, with `containsHolderBuys=false` and `completeLaunch=false`.

Every construction still returns `signingAllowed=false` and `executionAllowed=false`. The existing API continues to enforce create-only behavior until the new path has independent preflight and durable approval integration.

## Evidence and validation

- Nine focused Node 24 test files passed, 66 tests. Coverage includes existing create-only preflight/signing/API/UI regressions plus new native/stock atomic construction, direct wire-format header/config/instruction/tail-signature checks, legacy SDK decoder compatibility, supplied ALT rejection/activation, cancellation, bounded v1-aware discovery and real disposable libSQL saved-plan binding.
- Actual-source TypeScript, scoped typed lint and the Node 24 production build passed on the final application source.
- A bounded read-only mainnet diagnostic selected a successful recent Pump transaction. Reading it with `maxSupportedTransactionVersion:0` returned JSON-RPC `-32015`; requesting integer `1` returned the successful matching transaction through both raw JSON and Bundle's integer-preserving RPC adapter. Discovery now requests version 1 and reports successful v1 rows without inventing lookup tables.
- Four public RPC reads collected native configuration and submitted an **unsigned simulation only**, with a newly generated unfunded payer/mint. The version 1 packet was 1,234 bytes, three instructions, zero ALTs. The RPC accepted its format and returned `AccountNotFound`, zero units consumed. This is an expected failed simulation of an unfunded account, not successful preflight or funded execution.
- Three public RPC reads collected current Global, QuoteControl and exact TSLAX mint bytes. An unsigned stock-quote packet was 1,280 bytes, four instructions, zero ALTs. Quote admission came from QuoteControl, using Token-2022 and eight decimals. The mint exposes MetadataPointer, PermanentDelegate, DefaultAccountState, ScaledUiAmountConfig, PausableConfig, ConfidentialTransferMint, TransferHook and TokenMetadata extensions. This establishes observed admission/encoding, not issuer authenticity, unrestricted transferability, successful trading, price or wallet funding.
- Safe diagnostic summaries are ignored local artifacts: `work/pump-v1-mainnet-research.json` and `work/pump-v1-stock-research.json`. No endpoint/key, wallet secret or signed packet was printed or committed.

## Required next integration

1. Independently collect and simulate the exact combined packet, preserving its original lifetime. Reconcile mint supply/metadata/authorities, developer and curve base-token amounts, native/stock quote debits and recipients, v3 retained protocol/creator fees, buyback fees, ATA/volume-account rent, executable/configuration stability, and maximum spend plus separate fee/rent allowance. Recheck any v0 lookup bytes/activation before approval and submission.
2. Bind the saved allocation, quote cap, version/config and packet to owned-wallet proof, immutable durable approval/reservations, current project/wallet revisions, browser key lifecycle and strict dual-signature reconstruction. Adapt packet-size/receipt handling for v1 only as part of that validated path.
3. Add explicit UI review and separately approved submission/recovery. Include all requested holder buys and timing requirements rather than treating a developer-only component as a complete bundle. Keep unsupported settings rejected.
4. Run a human-approved funded end-to-end proof only after the complete safety and signing flow is ready. No funded test or unattended signing is authorized by these unsigned read checks.

No UI, migration, hosted database, deployment or transaction changed in this checkpoint. No signatures, broadcasts, Google agreement acceptance or provider-credential changes occurred. Wallet login remains the separate local commit `9a611a4`.

Sources: [pinned Pump IDL](https://raw.githubusercontent.com/pump-fun/pump-public-docs/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump.json), [Pump v3 trade documentation](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/instructions/TRADE_V3.md), [Solana transaction formats and v1 resource limits](https://solana.com/docs/core/transactions/versioned-transactions), [Solana getTransaction](https://solana.com/docs/rpc/http/gettransaction).
