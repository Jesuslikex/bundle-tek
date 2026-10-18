# Marketplace selection and display parity

18 October 2026. Local Codex-owned catalog/UI work, separate from the other chat's account-costs implementation. No inventory provider, credential, purchase, wallet import, signing, migration or deployment change.

## Reference and scope

Reused the matching retained live REA marketplace inspection in `CODEX-PROXIMA-MARKETPLACE-REA-20261018.md`: populated preview `ev_d1d3a23091b4db97da68330b36cbf4b536b78e2aa6c237965b467b80cf34e55e` and semantic inspection `ev_f6e7b4b438d8ee960ca35177650ad5fe5c277a4639200317cf56e74ccfad39b1`. Its observed controls include quantity, multiple sources/tiers, sortable columns and per-row costs. Its empty purchase history never proved payment or delivery behavior.

The current public [Marketplace documentation](https://docs.proxima.tools/wallets/marketplace/) was read separately on 18 October. It describes count/source/tier filtering, reviewing prices and totals, and separate one-payment/delivery/history stages. It is documentation evidence, not a qualified provider or execution contract.

REA discovery through the approved loopback9223 endpoint succeeded with `ev_c96b27779305ad4ab81a45b612e1e56a622473ed32395c5a9c70203366aa71b8`, showing the existing Proxima account target. This chat did not navigate that target while the other chat owned the live account investigation. No new live marketplace capture is claimed in this checkpoint.

## Implemented result

- Quantity is now any whole count from **1 to 200**, with the existing25/50/100/200 shortcuts. The default25 and upper200 bound are preserved. A response can honestly contain fewer matching entries than requested.
- Multiple source and history-tier choices are optional extensions to the internal catalog filters. Sources come only from the last validated provider inventory; none are invented. A manual single exact source remains available and clears multiple source choices, while selecting multiple sources clears the single field. Tiers can be combined without guessing activity timezone or quality beyond the reported enum.
- Multi-value query fields use one bounded JSON array per key. Duplicate entries, unsupported tiers, empty/oversized arrays, conflicting single/multiple fields and repeated URL keys are rejected before provider access. Arrays are canonically sorted for client/server echo comparison. Existing single filters and default serialized fields remain compatible. The inventory-provider request and strict v1 listing schema are unchanged.
- The table can sort by price, balance, price less balance, funding time or transaction count. Comparisons use exact integer values, including differences beyond JavaScript Number precision. Sorting copies the displayed array; it does not select a different wallet set, alter captured totals or fetch again. Equal values have a stable ID tie order.
- Each wallet now shows price less listed SOL balance separately. This is not all-in cost, a reserved quote or profit. Existing indicative-price and provider-assertion disclosures remain.
- On phones the table is replaced by full-address cards with every metric visible and a native keyboard-accessible sort control. Desktop headers retain semantic `aria-sort`. Changing catalog filters or presets still invalidates the old preview; Reset restores the default count and clears multi-select choices. Existing snapshot expiry remains visible.

Checkout remains forced to `purchaseEnabled:false`, including response validation. There is no purchase button, payment, provider order, key delivery or browser-vault import. Funding-age minimums, quantity ceiling, read bounds, provider timeout, source validation and authentication are unchanged apart from admitting supported custom counts inside the existing ceiling.

## Verification

Final pinned Node24 offline selection: **43 tests across four files**, all passed. Evidence: `work/release-qa/marketplace-selection-final-20261018.json` and matching `.config.mjs`. The selection includes model, provider transport boundary, mounted UI and authenticated catalog route tests. It covers custom count edges, canonical multi-filters, malformed/repeated/conflicting inputs, exact sorting and negative price-less-balance values, nonmutation, no-refetch sorting, presets/reset, stale-result cancellation, expiry, safe errors and refusal of purchase authority. The provider cases use controlled transports; no live supplier is qualified.

Five-file type-aware lint and six-file formatting pass. Plain whole-project TypeScript passed during this checkpoint; the final production-copy build also passed its complete TypeScript phase.

Actual production component/CSS and selection model were rendered in the existing Chrome profile with three synthetic listings. All provider, purchase and external requests were refused. Selecting count7, Classic/Exchange and Funding only/Established yielded two matching entries with exact totals2SOL balance,2.200000002SOL price and0.200000002SOL difference. Desktop price sorting and phone native-select/ArrowDown sorting left the fixture read count at two and totals unchanged. A label-locator mismatch was resolved using the observed combobox role; no UI behavior was bypassed. Snapshot expiry became visible during inspection.

Client/scroll widths:1440/1440 desktop,360/360 at375px and305/305 at320px. Phone cards show the complete address, balance, price, difference, activity count, source/tier and funding timestamp. This rendered sample has two selected cards, not a200-card performance qualification. Screenshots and harness: `work/marketplace-selection-qa-20261018/{desktop,mobile,narrow}.png`. The fixture tab closed, viewport reset and only the owned loopback4198 server stopped; normal HTTPS and Proxima targets were preserved.

## Build and remaining work

The isolated Node24.19.0 `next build --webpack` pins committed baseline `b6001674bc2ee1092baa28adb18a6341b9a82600` plus exactly the six owned marketplace files. **Next and wrapper both exited0**, handle75221, compilation51seconds, TypeScript40seconds, six pages2.6seconds; no owned source hash changed. It excludes environment/credential files and uses the existing node_modules junction; it does not replace root `.next`. Evidence prefix: `work/release-qa/marketplace-selection-build-20261018` (`.source.json`, `.exit.json`, `.log` and pinned source copy). Log SHA256: `d6c201fc4935712b95fd466922e030bcde317cb7ba5f2d0e12c8b7d42b1de68b`. The parent-workspace tracing-root warning is retained; application output is isolated, not dependencies. This includes the committed funding and account-costs checkpoints, not subsequent uncommitted changes in another chat.

This supersedes the earlier comparison's fixed-count, single-source/tier, unsortable-table and missing-per-row-difference gaps only. Qualified live inventory, EVM/multi-chain data, optional/sub-day age and spacing UX, timezone coverage, cross-folder spacing evidence, authorized checkout/payment/delivery and owned purchase history remain open. A combined current-source full regression is still required. No push, deployment, hosted SQL, provider/credential/cron change, real wallet unlock/sign/send or funded action occurred.
