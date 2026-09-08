# Proxima reference review — 8 September 2026

Inspected the user's signed-in Proxima tab in Chrome, read-only. No keys were revealed or exported, no real launch was submitted, no wallet was bought or funded, and no private reference-account data was copied into this repository.

## Product overview

Proxima's strength is its connected workspace: persistent projects remain in a searchable sidebar while the center moves through chain/launchpad, token identity, launch settings and funding. A compact right rail explains the selected scenario. Dashboard, wallets, tracking, archived projects and activity surround that same project flow.

| Reference surface inspected | Observed behavior | Bundle implementation / remaining gap |
| --- | --- | --- |
| Dashboard | Network/date filters, launches and P&L, affiliate section | Actual saved-draft counts, network filters and project table. No fabricated P&L or affiliate claims. |
| Create launch | Five networks and venue-specific options | All five planning profiles and 26 venues; selection updates valid quote currencies. |
| Robinhood | 13 venues, Pons V2 options, long.xyz stock-token quote catalog | Updated catalog, searchable 63-symbol long.xyz list, saved Pons tax/buyback and hood.fun supply/community preferences. These are draft fields, not contract parameters certified for execution. |
| Token details | Name/symbol/description, artwork and social links, preview | Identity form, public artwork URL preview, saved social links. File upload/storage is not connected. Existing 13-character ticker contract retained. |
| Draft / imported settings | Mode, allocation, recipient count, presets, wallet roles, advanced parameters, funding | Existing scenario controls preserved and reorganized. Real wallet import, CEX funding, venue-specific launch settings and execution remain unimplemented. |
| My Wallets | Solana/EVM sections, folders, balance/volume/P&L, bulk actions | Dedicated entry to existing Solana devnet wallet verification. EVM wallets, folders, bulk custody and withdrawal are not implemented. |
| Tracker | Wallet list and bulk/add-wallet actions | Existing read-only supply analysis retained; not a persistent wallet tracker equivalent. |
| Import | Contract-address import | Existing Robinhood token metadata inspector retained; not a functional import into an executable launch. |
| Marketplace | Aged-wallet filters and priced inventory | Inspected only. No purchasing, inventory, activity generation or marketplace implementation. |
| Activity | Launch/wallet tabs, date/network/category filters, grouped events | Existing wallet/Pons audit records remain; no unified activity dashboard yet. |
| Archived projects | Archive destination in the project workspace | New recoverable archive/restore, plus independent duplicate drafts. |

## Venue catalog observed

- Solana (8): PumpFun, LetsBonk, Bags, Anoncoin, Surge, Printr, Meteora DBC, StonkFun.
- Robinhood (13): pons.family, o1.exchange, long.xyz, flap.sh, hood.fun, stonks.fun, pools.trade, klik.finance, Livo, REAL, meme.bid, Uniswap V2, Uniswap V3.
- BNB (2): FourMeme, Flap.
- Ethereum (1): Uniswap V2.
- Base (2): Bankr, Clanker.

Reference: https://app.proxima.tools/launch/create/launchpad . This is an observed UI catalog, not a claim that all underlying services work or a recommendation to trade these venues.

## Delivered architecture

`workspace_projects` is a new owner-scoped D1 table introduced by generated migration 0005. `/api/projects` stores complete validated plan/identity/options documents. The library supports up to 100 projects per owner, duplicate creation, monotonic optimistic revisions, recoverable archiving and restoration. Writes require authentication, JSON and same-origin browser requests. Unknown metadata fields are stripped; credential-bearing and non-HTTP URLs are rejected. Storage faults return safe error messages.

The previous single-plan record is preserved. When no library projects exist, it is loaded as a draft and can be saved into the new library. No remote database migration has been applied in this turn. The new migration was applied only to local development D1 for verification.

Existing Solana devnet ownership verification, memo/distribution tools, read-only supply analysis, Robinhood token inspection and unsigned, mainnet-gated Pons V2 coordinator were retained. Mainnet execution remains disabled. The new work is a functional planning-workspace clone, not complete Proxima backend parity.

## Verification

- Final `npm run check`: 112 tests across 31 files, TypeScript and production build passed with exit code 0. Focused UI/API lint and `git diff --check` also passed. A transient Windows libuv shutdown assertion on the preceding build did not recur with the preview server stopped.
- Actual local D1 tests cover generated migration, authenticated reads/writes, owner isolation, duplicate creation, concurrent stale-save rejection, archive/restore, validation, cross-origin rejection and per-owner limits.
- Chrome exercised the real local development sign-in, Robinhood → long.xyz → NVDA, token identity/socials, save, complete reload, reopen, archive, restore, independent duplicate saving and unsaved-edit confirmation. Both synthetic QA drafts were archived locally after the check; they remain recoverable.
- Desktop and mobile inspection caught and corrected the hidden mobile Save button and overflowing step navigation. Phone-size chain/token views have no document-level horizontal overflow.
- User Chrome extensions inject an HTML attribute (`data-qb-installed`), producing a hydration warning during development. No extension setting was changed to suppress it.

## Hosting status

The existing hosting manifest is unchanged. The connected Sites service returned `project_not_found` for its exact project ID, and the current accessible-site listing had no PulseForge/Bundle match. Do not create a replacement project, overwrite the manifest or claim the existing public website was updated. Reconnect the account/workspace owning the original site before preparing a public release.
