# Live marketplace comparison

Later local update,18October: `CODEX-MARKETPLACE-SELECTION-20261018.md` supersedes this comparison's fixed-count, single-source/tier, unsortable-table and missing per-row-difference rows. Phone cards were also added. The table below records the earlier source checkpoint and is retained as historical evidence. Qualified provider, chain/timezone/folder evidence and checkout/delivery/history gaps remain; no new live marketplace capture or purchase proof is implied.

18 October 2026. Read-only REA observation of the existing signed-in Proxima session, compared with local Bundle main `84a9b03`. No purchase, wallet import/export, funding, signing, filter-value edit or provider setup occurred. Application source remains frozen for the separate full offline suite.

## Evidence and limits

Navigation evidence `ev_3aa111d59995edcc2a4091bddbba044c2c11c66627e52cc34ded049d6fc2043f` reached `https://app.proxima.tools/marketplace` through its visible sidebar link. The immediate snapshot preceded the marketplace content load; it is not evidence that the page was empty.

Loaded screenshot `ev_d1d3a23091b4db97da68330b36cbf4b536b78e2aa6c237965b467b80cf34e55e` at `2026-10-18T07:03:09.037Z` is 1920×945, 361169 bytes, SHA256 `276f334fce1d3a5107e1878370a3115becb07cfb291c64a3591f5609498c38ba`. It shows a populated Solana preview, a filter rail, a scrollable inventory table, totals, and a purchase button. This proves visible preview UI, not provider truth, ownership, fulfilled delivery, an API contract or successful payment.

Loaded semantic inspection `ev_f6e7b4b438d8ee960ca35177650ad5fe5c277a4639200317cf56e74ccfad39b1` is policy-filtered and attach-limited. It retains no raw request/response bodies, header values, cookies, storage values or secret exports; pre-attachment activity is unavailable. Nothing here identifies Husher or proves a backend relationship. Visible exchange/source labels are marketplace assertions.

The first advanced-filter action used the CDP uppercase computed name and timed out (`ev_5993a652b8dd61357b44911aedd2da40df3fb076a023e010b092086aadb0ff18`). Its retained browser snapshot showed the actual locator name `Advanced filters`; the corrected action completed as `ev_f92541ad6301e3ebcebdbe35d48aae67adf9ec2535d7821415c38fa1722d9877`. No filter value was edited.

History-tab evidence `ev_0bd088b3365624ff26b61b97e6d0ae4953b0fa9c7d424917d69f8ee37a873ed8` shows Purchase History and the account's empty state, “No purchases yet.” Receipt/delivery behavior cannot be inferred from an empty history. The account page and original collapsed sidebar were restored afterward, `ev_adccd2882d9344cbd055dcf76c6c9eca77f187e95058bf8999b84544ac189220`.

## Observed controls versus current Bundle source

| Capability | Proxima visible UI | Bundle main source |
| --- | --- | --- |
| Network choice | Solana, Robinhood, BSC, Arc, Ethereum, Base selectors | Catalog schema accepts Solana only. Other selectors' inventory or execution support was not tested. |
| Count | Quantity input and 25/50/100/200 presets; available count | Same four preset counts; no arbitrary count input. |
| Funding spacing | Optional gap, 30m/1H/12H presets and duration/unit | Integer minute minimum gap; no optional switch or presets. |
| Funding age | Recommended over-one-day switch; advanced min/max in hours | Required minimum age in whole days, at least one; optional maximum days. |
| Quality | Multi-select tiers 0/1/2 with funding-only/light-history/established descriptions | Same three conceptual tiers, single selection. |
| Funding source | Multi-select source/exchange controls | One exact source text filter. No live provider qualification asserted. |
| Activity timezone | US East, US West, Europe, Asia | No timezone field in catalog contract. Do not invent this from an address. |
| Balance/activity ranges | Numeric and slider bounds for balance and transaction count | Numeric SOL balance and transaction-count bounds. |
| Folders | Destination folders plus separate spacing against existing-folder funding times | No destination-folder assignment or cross-folder funding-time constraint. Current gap only compares selected candidate listings. |
| Table | Trader labels/tier/timezone/count, balance, price, net cost, funding; sort/filter controls | Address, balance, price, source/tier, funded timestamp, transaction count. Cheapest-first selection; no user table sorting/filter menus or per-row net-cost column. |
| Totals | Total balances, total prices and net price | Exact integer total balance, price and price-less-balance already implemented. Avoid reporting these as missing. |
| Refresh/history | Regenerate, Preview and History | Explicit Refresh inventory, snapshot expiry/coverage and reset; no purchase history. |
| Checkout | Visible purchase button; not activated | Contract forces purchaseEnabled=false and UI explicitly says checkout unavailable. |

Source inspected: `components/marketplace-panel.tsx`, `lib/marketplace-catalog.ts`, `lib/marketplace-provider.ts`, and `app/marketplace/page.tsx`. Bundle already has authenticated catalog/provider foundations, strict response/filter validation, exact SOL conversions, expiry, cancellation, rate-limit/setup messages, advanced filters and totals. Calling it an entirely missing marketplace would be inaccurate. A live provider is not established by this source inspection.

## Remaining work

Prioritize a qualified provider contract and richer read-only catalog fields before adding controls that imply unsupported filtering. Then verify quantity/spacing UX, multi-select filters, folder-time evidence, user sorting and per-row costs against actual source data. Unknown timezone, chain, age or source provenance must remain unavailable rather than guessed.

Purchase parity separately requires immutable owned quotes/reviews, explicit user authorization, one-attempt payment/recovery, verified delivery matching the listing, browser-vault import and owned recoverable history. The observed purchase button does not establish any of these backend details. No checkout or wallet-acquisition authority was added here; those stages remain incomplete.

The parallel persistent-chart proposal remains the next local UI integration step after the full-suite freeze ends. This comparison broadens the concrete parity requirements; it does not replace them with a narrower catalog-preview target.

## Separate wallet-page cross-check

Read-only navigation to the existing `/wallets` page completed as `ev_6a494f7abe1d0cc6e913a056c341534e04f461e175b45a499598e2896fffd6e3`. The immediate snapshot preceded content load, so the loaded semantic inspection `ev_a2bb6d4df9fcccbd43876e268ba2d3e1a5a8f12ebe277db90cf1b66e0b06e315` and screenshot `ev_2414d3618ab555e789cbe85af7e805df2c0627c7a223550fdac9684b7fcc1700` are the relevant UI evidence. The latter was captured at `2026-10-18T07:27:56.344Z`, 1920×945, 165138 bytes, SHA256 `bc8da27cc22483a8c800990f8a29a7d1ce64cca2b5d6083800635f108ccd4269`.

Observed: network/folder rail, folder archive/deleted-wallet views, search, bulk selection, Create/Funding/Withdraw/Generate Activity/Delete/Manage controls, and a wallet table with balance, volume, P&L, launch and funding columns. Generate Activity, Delete and Manage are disabled when no wallets are selected. No wallet selection or operation was performed; create/export/funding/withdrawal/activity controls were not activated. In particular, this does not prove the Generate Activity configuration, execution backend, P&L accounting or warmup success.

Bundle source already contains folder/search/archive management, browser-vault creation, public CSV export, funding/withdrawal entry points and guided warmup components. The observed Proxima toolbar is not grounds to report those as wholly absent. A comparable global wallet volume/P&L/launch-history summary requires its own scoped data and accounting evidence; project-local observations and UI labels cannot substitute for it.
