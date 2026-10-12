# Direct wallet movement classification

Implemented locally on 2026-10-12. This extends the read-only movement evidence workflow; it does not extend trade execution or signing permissions.

## Supported evidence

- Existing Jupiter ordinary/shared V1/V2 route evidence remains supported.
- PumpSwap: `buy`, `buy_exact_quote_in` and `sell` from the pinned public AMM IDL. These are token-to-token PumpSwap operations, not native SOL Pump.fun bonding-curve instructions.
- Raydium AMM v4: legacy fixed-input/fixed-output opcodes 9/11 with 17 or 18 accounts, and V2 opcodes 16/17 with eight accounts.
- Raydium CPMM: `swap_base_input` and `swap_base_output`, exactly 13 accounts and 24 bytes, under the mainnet CPMM program. Raydium CLMM, stable pools and other layouts remain unresolved.

The classifier requires one successful supported top-level route, a tracked wallet signer matching its decoded authority, owned source/destination token accounts, complete token changes and actual parsed SPL transfer legs. Direct-route transfers must use the decoded pool vaults or declared fee accounts. Input/output totals must satisfy the instruction's exact or bounded amounts, and the selected mint's wallet delta must reconcile exactly with its transfer legs. PumpSwap mint roles must also agree with the owned account mints.

Buy/sell direction is relative to the selected mint, not the instruction's name. A protocol `sell` receives the opposite asset: when that opposite asset is the selected mint, its acquisition is a buy. Native balance direction, pool-provider side labels and fee/rent changes alone never supply a buy/sell label. Ambiguous operations, unsupported layouts, extra custom top-level programs and multi-route transactions remain unknown.

The tracked-transaction decoder now validates raw instruction account references and parsed source/destination/account references against the transaction's account keys. Other retained public address facts must be canonical Solana addresses.

## Display and persistence

Wallet alert transaction evidence now shows the decoded protocol, exact opposite-asset units and mint link, with expandable classification reasoning and counterparty token-account links. Those accounts do not establish wallet ownership. Older saved records without classification remain readable and explain that inspection is needed to apply current decoders.

New direct labels use `protocol-route-and-transfers` with a pinned protocol name. The existing server/client evidence validator accepts this basis while preserving old Jupiter records. No database migration was needed. A real authenticated D1 route test verified save/load of a generated PumpSwap classification.

## Provenance

`lib/movement-route-schema.json` records the source URLs, capture timestamp and SHA-256 of each upstream source. `scripts/update-movement-route-schema.mjs` derives PumpSwap discriminator/account roles and pins reviewed Raydium opcode/account layouts. It is a maintenance script, not a runtime network dependency. Review the source/layout diff before using any future regenerated schema.

Primary sources:

- [PumpSwap public IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json).
- [Raydium SDK instruction constructors](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/liquidity/instruction.ts).
- [Raydium program IDs](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/common/programId.ts).
- [Raydium AMM processor](https://github.com/raydium-io/raydium-amm/blob/master/program/src/processor.rs), which explicitly accepts the legacy swap forms with and without the optional target-orders account.
- [CPMM SDK swap constructors](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/cpmm/instruction.ts).
- [CPMM Swap account roles and fixed-input implementation](https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/instructions/swap_base_input.rs).
- [CPMM mainnet program declaration](https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/lib.rs).

## Verification

- 245 tests across seven focused files passed, including existing Jupiter route cases, all seven new direct layouts, rejection cases, real RPC-decoder-to-classifier integration, exact fee-leg accounting and legacy compatibility.
- Eight tests in the real Miniflare-backed supply-movements API suite passed separately, including saving/restoring the new direct classification through authenticated owner/project/interval checks.
- TypeScript, scoped lint, diff whitespace checks and the production build passed. The existing large-client-chunk warning remains.
- Browser QA rendered the production movement label with generated synthetic evidence. Reasoning and public counterparty links expanded correctly. At 390px, client and scroll widths both measured 375px after scrollbar allocation. Desktop/mobile screenshots were inspected: `outputs/direct-movement-desktop-qa.jpg` and `outputs/direct-movement-mobile-qa.jpg` in the chat workspace.
- Claude's holder/watch-wallet files were not edited. No credential read, real wallet signature, transaction submission, database migration or deployment occurred.

Live public direct-DEX transaction QA remains outstanding. Native Pump.fun bonding-curve classification, further DEX layouts, complete holder enumeration, background monitoring and production/funded execution verification remain gaps in the broader Proxima goal. These tests and synthetic previews do not prove those requirements complete.

### Optional target-orders coverage correction

The official processor's `process_swap_base_in` and `process_swap_base_out` accept exactly 17 or 18 accounts. The 17-account form omits target-orders at index 4, moving pool vaults to indices 4/5 and wallet source/destination/authority to 14/15/16. Added separate pinned variants for opcodes 9/11. Variant selection now requires both opcode and the reviewed account count; it never guesses the layout from the opcode alone.

The schema maintenance script checks the processor's count guards, conditional target-orders consumption and complete account role order before pinning these variants. Its fourth source hash records the reviewed processor. The earlier three upstream hashes were unchanged during regeneration.

Twenty-two focused classification, direct decoder and pool movement tests passed after this correction. All nine pinned direct layouts run through fixture classification and the actual RPC decoder tests. Additional independent tests remove only target-orders from an 18-account instruction and confirm identical decoded roles, reject a removed vault and reject unsupported 16/19-account forms. TypeScript, scoped lint and all five production build stages passed. No live read was repeated, so this does not establish the reason for the earlier unknown public sell or a positive live classification. Claude's files remain untouched.

### Raydium CPMM movement classification

Added the CPMM mainnet program and two exact layouts to the pinned schema, bringing direct coverage to three protocols and eleven layouts. The generator checks the program ID against both the program declaration and SDK, derives Anchor discriminators and checks them against the SDK bytes, verifies the complete Swap account role order and verifies each SDK constructor's account/argument order.

The classifier requires payer at index 0 to match the tracked signer, wallet token accounts at 4/5, input/output vault boundaries at 6/7, declared token programs at 8/9 and mint roles at 10/11. The fixed-input form requires exact input and minimum output; fixed-output requires maximum input and exact output. Mint roles must agree with owned wallet account mints. Standard SPL and Token-2022 program IDs are admitted only when existing instruction and exact balance/transfer reconciliation succeeds. Token-2022 fee-adjusted outputs and unsupported fee/hook instruction forms remain unknown; full extension support is not claimed.

Validation: 25 direct decoder/classifier/pool movement tests, three rendering tests and nine authenticated real Miniflare supply-movement route tests passed. The route tests save and restore both PumpSwap and CPMM classifications. Fixtures cover all eleven layouts through the actual transaction decoder, and CPMM tests reject substituted mints/programs, wrong account counts and fee-adjusted output mismatches. TypeScript and scoped lint passed. Live CPMM classification and browser visual acceptance are unverified. This extends read-only classification only, not transaction construction or execution. No live RPC call, signing prompt, submission, credential read, migration or deployment occurred. Claude's files remain untouched.

Final CPMM production build: all five stages passed; the existing large client chunk warning remains.
