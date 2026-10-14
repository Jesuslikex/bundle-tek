# Proxima versus Bundle: fresh REA recheck

14 October 2026. Compared live Proxima browser controls and bounded network metadata with Bundle main at 6065491 (latest application checkpoint ac8621f). This is an audit, not a deployment or funded execution test.

The user has now authorized Codex to take over UI work while Claude is out of credits. Preserve Claude's existing work, announce UI scope before edits and keep verified local commits. No push, hosting, credential or financial authorization is implied.

## Fresh reference findings

The existing Chrome debugging browser was reachable from Windows. REA initially returned endpoint_unreachable because the temporary WSL relay was absent. Restarting the existing approved loopback/stdio relay restored actual REA discovery and inspection. Relay session 62674 remains available; no browser profile, MCP configuration or credential was changed.

REA navigated the existing signed-in target through account, launchpad, PumpFun Custom quotes, StonkFun Custom/xStock quotes, blank Token Details, Wallets, an existing live token workspace and Marketplace, then restored /account. No token identity was entered, file uploaded, project created, wallet exported, runner configured, purchase made, transaction signed or broadcast. Selecting venues changed only the unsaved form. Normal page queries, telemetry and subscriptions occurred.

- Proxima displays six chains: Solana, Robinhood, BNB Smart Chain, Arc, Ethereum and Base. Current displayed venue counts are 11/15/4/5/1/2. Bundle already includes six chains and the 11 Solana venue names; older five-chain/eight-Solana documents are historical. Bundle's Robinhood list includes 16 names, so catalog membership still needs venue-by-venue reconciliation.
- PumpFun exposes SOL, USDC and Custom launch currency. Custom includes TSLAX, NVDAX and SPYX plus many other assets. Display labels alone do not authenticate issuer/mint identity or prove execution.
- StonkFun exposes a Custom picker with Solana, Currency, xStock, PreStock, Sunrise, Custom, Leverage, Collectibles and Tessera categories. The inspected xStock tab includes Tesla, Nvidia, S&P 500 and Apple-labelled assets. Standard/Rewards fee modes are separate controls.
- Pump creator-reward choices include Creator/Holders, otcdesks, UsePaid, Ansem Launch and Creator Fee Distribution. In particular, paying creator rewards in a stock is a different feature from using a stock token as the launch quote asset. These integrations are not implemented execution features in Bundle.
- Token Details offers JPG/PNG/GIF and MP4/WebM media, name/symbol/description/social fields and Advanced Settings. Its Create action remains disabled on the inspected blank form. No upload or creation success was tested.
- Wallets shows folders, Create, Funding, Withdraw, Generate Activity, Manage and Export controls. Their presence is not proof of custody, activity generation or execution semantics.
- The live token workspace exposes price/supply/market statistics, a chart iframe, wallet/trade/holder/history/bubble-map views, Market/Limit/Grid tabs and runner configuration. Normal responses include chart subscribe/symbol, wallet reads and autobuy/autosell/volume/cleanup/sniper-guard status endpoints. HTTP 200 does not establish a working trading strategy or complete chart data.
- Marketplace displays priced wallet inventory, filters and a purchase control. It was inspected only.

## What Bundle has and what is missing

Everything in the implementation column describes local source. This audit neither updated nor certified the public site.

| Area | Present locally | Remaining gap |
| --- | --- | --- |
| Launch artwork | Authenticated PNG/JPEG upload, 512 KB bound, saved identity, explicit publication consent, immutable public image/metadata release API and review UI | GIF/video, authenticated published-site upload verification, stable public hosting. Upload is not a coin launch |
| Pump coin creation | Pinned create_v2 unsigned builder; exact saved project/release binding; owned deployer proof; mainnet preflight and original-packet simulation API | New mint key generation/encrypted persistence; preflight UI; durable approval/reservations; initial developer/holder buys; authority policy; explicit dual signing/submission and receipts; funded proof |
| Stock quote assets | Catalog selections for Pump/Stonk; Pump quote-admission and Token-2022 inspection code. Earlier 14 October public reads admitted exact TSLAX/NVDAX/SPYX mints at slot 456665566 | Independent issuer verification, quote-asset funding/swaps, full create-plus-buys execution. The earlier read was not repeated in this audit |
| StonkFun | Planning/catalog/metadata support | Its own verified program/platform configuration and transaction adapter, simulation, approval/signing and receipts. Pump adapter explicitly rejects StonkFun |
| Wallet preparation | Browser AES-GCM/PBKDF2 vault; generation/import/export; saved roster/folders; warmup plans/history and cycle review/signing components | Current integrated/funded proof. This does not create historical wallet age or implement the marketplace |
| Trading and Jito | Jupiter buy/sell preparation, SOL wrapping, review/simulation/receipts; one-to-four swap Jito bundles plus tip, retained events/recovery | Funded buy-to-sell and atomic-bundle proof; wider asset/layout/venue support; launch-plus-initial-buy bundles |
| Token workspace | Chart, market reads, trading form, wallets, holder/history panels and alerts | Rendered full-workflow and live-feed QA, consistent compact layout/statistics, broader coverage; not certified as exact Proxima UX |
| Holders and movement | Persisted paginated index, grouping/search, saved watch baselines, retry/continuation and scoped buy/sell/transfer decoders | Large-token complete censuses, nonzero extension-fee/hidden-balance coverage, complete wrapped/multi-hop settlement and live integrated alerts. Historical 100% small-token coverage is not universal coverage |
| Limit/Grid/DCA | Persisted terms, timing/budgets, fresh conditions, explicit per-transaction approval/recovery | Funded current-flow proof and hosted operation |
| Counter and automation | Counter rules/evaluation/quotes, unsigned preparation/simulation/reservation libraries; conditional read-only monitor API/UI | Counter approval/signing API integration, broader Counter assets/Sell/shared limits; deployed after-close monitoring. Worker remains disabled/unscheduled; no unattended signing |
| Performance | Receipt-backed costs, activity/timeline and partial FIFO accounting | Complete indexed history and independently reconciled P&L |
| Marketplace / other chains | Marketplace reference research; other-chain planning catalog | No Bundle wallet marketplace; no complete multi-chain launch execution |
| Release | Local builds, tests and separate CROP candidate | Friend-owned original remote and unresolved partial CROP migration recovery remain documented release blockers. Not re-probed or altered in this audit |

Source checks include lib/launch-plan.ts, lib/quote-catalog.ts, lib/browser-wallet-vault.ts, components/launch/artwork-upload.tsx, components/launch/token-details-form.tsx, components/imported-trade-sessions.tsx, app/api/artwork/route.ts, app/api/launch/pump/preflight/route.ts and lib/owned-pump-preflight.ts. The latter explicitly returns executionAllowed=false, signingAllowed=false, completeLaunch=false and containsInitialBuy=false. app/api/launch currently has plans, metadata and Pump preflight routes, not a launch signing/submission route.

## Evidence and coverage

Fresh REA evidence:

- Discovery: ev_bb425926dd7f6b3897d960d5b2d64c8779fec592ead32e51c2ba1ad67b98720e.
- Passive account: ev_179be35de6a5ee1d784a7a898e769b7dccd031dea8394e5cb762e6a247024518.
- Launch catalog: ev_6081454785565cee9d9c7c8ea94b0cf99e11b74f8bd619ba94e4c5bc2cb63723.
- Pump selected: ev_0b184ada044a224ab6a6c7a47690b793034d6170257f05f2bed1b45317015543.
- Pump Custom: ev_199e23171578e50bf660293a9a494e25d70a75f0265610518d5b74bcded4eb61.
- Stonk selected/custom/xStock: ev_3b735b08c93ceb74c7dbdb37a5b7572b208881a1a541bf293d0da642c2f5bd60, ev_5e88f459274bb48a2c586454c2d38b4053e1de3c7ae4c87cb21b252dcd2470e1, ev_5c66fce496ceba9e0a3d90979939ab81a8839a5ec0ac525e34c0d2ab16827fce.
- Token Details: ev_4524451649db8d05086d0a6ed765d889768cdd77daed7b5baa8a7000a21b33a7.
- Wallets: ev_f8a66de6e3e1a86c27e88e7d7ba619c491424de28bd98bbab97fcce2d139ae67.
- Live token: ev_626c10ee6bf9e796c59f9668b325ddd0248b040c51fafbae510e62b6dd76d370.
- Marketplace: ev_2c309891d98ce1d2a14dc5b87b3a242525d020bf5e4e30c97d51d1b38ab00a58.
- Account restored: ev_c0f54b48540c5b49a1a58ef44f43f48e93b01d0617f9f026921c345f62e0cadb.

Complete session export: C:\Users\Julian\Desktop\REA\results\proxima-recheck-20261014-0211-evidence.json. 15 records, 1,310,327 bytes; SHA256 1e8d18a0e4b5e863cb4b066a788ad0d6d067a31c56c4dc445f260e2362141165. Keep this local/private: account-specific accessibility text is present. Runtime evidence is not committed. A radio locator timed out; fresh passive inspection and clicking the visible Pump heading succeeded. The failed scenario remains in the evidence, not counted as feature success.

Capture used no network bodies/header values/storage values or script source export. Scenario metadata includes the page's normal dependency origins; passive capture was scoped to app.proxima.tools. Attach gaps and incomplete event capture remain explicit. No screenshot/layout or funded-flow proof was collected in this pass. Backend custody/signing/automation internals remain unknown. Previous full-file main-JS parsing succeeded but semantic analysis exhausted memory; this runtime pass does not resolve that static coverage limitation.

The existing 1,122-file Pump-preflight source snapshot verified unchanged at digest a11ddb21153dca77f31c43486f1ec115ec9170cacfa1271407d551bc7900f211. Its prior 75-test targeted/type/lint/build checkpoint remains applicable; tests were not rerun for this documentation-only audit. The older 2,153-test full suite predates Counter and launch additions and is not a current full-suite claim.

## Next implementation order

1. Browser-encrypted launch mint lifecycle and recovery/export; exact saved release/deployer/quote preflight review UI.
2. Quote funding and create-plus-initial-buy construction, authority/fee policy, durable approvals/reservations and explicit signing/submission/receipt recovery.
3. Separate StonkFun adapter and approved end-to-end proof for each supported path.
4. Recover hosting independently, then verify the actual deployed upload/launch/trading workflow. Do not label local source as live.
