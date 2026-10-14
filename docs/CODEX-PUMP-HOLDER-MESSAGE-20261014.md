# Unsigned holder launch packet checkpoint

Added a server-internal version-1 packet assembler for one coin creation, an optional developer buy and the complete ordered holder-slot list. Active holder intents explicitly distinguish exact base output plus maximum quote cost from exact quote input plus minimum base output. Inactive slots are retained without inventing a buy or requiring a signature for them. Slot identities must be unique across mint, deployer and all holders; signing identities are validated.

The assembler reuses the existing verified account derivation and ATA setup, includes only one creation instruction and retains each holder's ordered setup/trade instructions. It checks the complete signer set, leaves every signature null, includes the original blockhash lifetime and explicit v1 resource configuration, measures the final packet and produces its SHA256 fingerprint. Combined known token targets/minima cannot exhaust the initial curve reserve. Quote-input budgets can still cross a migration boundary, so independent sequential state/migration simulation is mandatory.

## Pinned source

The official [V3 trade documentation](https://raw.githubusercontent.com/pump-fun/pump-public-docs/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/instructions/TRADE_V3.md) distinguishes fee-inclusive `buy_exact_quote_in_v3` quote spending from `buy_v3` exact token output, using the same 17 account roles. The full IDL was fetched read-only and its SHA256 matched existing pin `7616681ea557975f9f623ac211080f22a93060781eaf4765b0a488d980997207` before extracting `lib/pump-exact-quote-schema.json`. The exact-quote discriminator is `[225,247,80,30,213,179,132,136]`; arguments are quote input, minimum tokens and false partial fill. No new SDK or paid provider was installed.

## Complete-group limits

The pinned compiler rejects more than 64 unique accounts. The assembler reports that requirement before compilation, and also rejects complete packets above 4096 bytes. An oversized group never returns a shortened/partial packet or silently drops addresses. This is a single-packet builder; larger saved groups require separately reviewed grouping/bundle execution. The compiler cap is not claimed as a newly verified universal network limit.

## Verification

Four focused files passed, 35 tests, Node 24: native and stock unsigned packets, all required signers, deterministic trade order, exact quote arguments/17 roles/false partial fill, holder-only buys, inactive slot retention, duplicate/mixed/invalid limits, exhausted curve, cancellation, oversized signer sets and measured account graphs, plus existing initial-buy/create/holder-target regressions. Actual-source TypeScript, scoped lint and production build passed on final application source.

No on-chain simulation, wallet signing, submission, remote migration, cron, credential change, push or deployment occurred. The quote schema fetch was the only external read. No UI or Claude-owned file changed; unrelated dirty main work is preserved.

## Still required

Bind these packet intents to the owned saved-target manifest and explicit per-wallet caps/minima, independently collect all funding/accounts and simulate sequential curve settlement and aggregate fee/rent/quote conservation. All-wallet reservations, durable approval, multi-wallet signing, submission/receipt recovery, UI and larger-group execution remain outstanding. Signing/execution/complete-launch flags remain false. Production stays at source `11ad20b`.
