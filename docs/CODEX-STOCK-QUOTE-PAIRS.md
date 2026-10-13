# Tokenized-stock quote pairs

User requirement, 13 October 2026: allow tokenized stocks to be the quote asset of a launched token's trading pair. This means the token/stock-token pair, not a stock-themed name, a stock price display or brokerage-share trading. This is part of the full Proxima goal.

## Current verified scope

The retained Proxima quote catalog already offers stock-labelled assets under Solana/StonkFun. The existing launch selector searches symbol/address and saves the exact quote mint with the symbol. A read-only local source check passed these examples through validateLaunchPlan and validateQuoteSelection, preserved the exact mint, and rejected substituting SOL as their symbol:

| Captured symbol | Solana quote mint | Captured decimals |
| --- | --- | --- |
| TSLAX | XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB | 8 |
| NVDAX | Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh | 8 |
| SPYX | XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W | 8 |

Evidence: work/release-qa/stock-quote-selection-20261013.json. These are captured catalog identities, not fresh issuer verification, venue admission, liquidity, launch execution or funded pair proof. No mint address was added from an unverified ticker search. The old friend-owned hosted page does not expose the current selector and has not been updated.

## Required completion

Discovery continuation, source commit 547c512: the three captured stock/ETF examples above are now in StonkFun's first four choices. Default and full asset identity sets remain unchanged across all 37 venue profiles. Fourteen existing tests, typecheck, scoped lint and build passed. See CODEX-STOCK-DISCOVERY-UPDATE-20261013.md for scope and retained before/after evidence. A dedicated stocks filter and issuer verification remain open.

Make stock/ETF quote choices easy to discover in the selector. Retain exact chain/mint/program/precision identity through save, reopen, funding, launch preparation, transaction review and resulting token workspace. Verify issuer identity separately from a ticker label. Reject a stock-labelled impostor and a quote unsupported by the chosen venue.

Before launch preparation, read the venue's current admission/configuration and mint extensions. Derive curve/price units, initial buy and recipient amounts from the selected quote token's precision. Do not substitute SOL or silently route a stock pair into a different pair. A post-launch quote-token price is not automatically the underlying share price; USD valuation requires the correct price/multiplier and freshness handling.

Current primary references checked on 13 October: [xStocks integration](https://xstocks.com/partner) describes stock/ETF tokens across networks; [Pump.fun coin creation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md) documents quote-mint creation accounts; [custom Pump coin quotes](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATE_WITH_PUMP_COIN_QUOTE.md) distinguishes approved quote mints from the custom path. These documents do not establish that each captured stock mint is currently admitted by each venue.

Launch execution, current venue admission, issuer/on-chain metadata checks, stock-specific discovery and funded token/stock-token pair proof remain unfinished. No browser upload, provider credential access, signing, transaction, push, version save, deployment or hosted SQL occurred in this verification. Claude-owned files and migration history were unchanged.
