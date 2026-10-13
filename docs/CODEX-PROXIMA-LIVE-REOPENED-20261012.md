# Proxima live reference, reopened session

## Passive continuity check, 13 October 2026

The existing approved dedicated CDP browser remained reachable on loopback port 9223. REA browser discovery evidence `ev_f07e11b78acb982e05aa493db88fdd4c8862893f5d3dc2e597b21e4c63ae2967` and passive inspection `ev_c43ce2b4f5314b0ff7ac1e1a5517356330fd777b5f5ce4783b49debe6ef1003e` cover the already-open live token workspace. Inspection ran from 04:23:58.352 to 04:24:01.592 UTC, without clicking, navigation, script execution, cookie/key access or transaction actions. Market, Limit, Grid, Auto Buy configuration and Auto Sell controls were present. No active Auto Buy, Auto Sell, volume or cleanup session appeared in the sampled accessibility state.

The short attach observed zero new requests/workers. That does not establish network inactivity, the absence of earlier connections or behavior after browser closure. Existing saved Auto Sell form evidence in `proxima-deep-20261012/autosell-modes.json` identifies Counter Trading, DCA and Limit Orders configuration choices, without submitting a strategy. Backend execution, signing/custody, durable monitoring and actual strategy outcomes remain unknown. This check supplies current runtime continuity, not full parity proof.

Read-only REA inspection on 2026-10-12 around 21:16 to 21:20 UTC. The user manually reopened the previously approved dedicated Chrome profile. Windows and WSL were connected by the existing loopback/stdio relay, with no cookie copying or authentication export. No wallet creation, export, funding, runner modification, signing or submission controls were activated. Navigation allowed Proxima's own normal page queries and subscriptions.

## Observed behavior

- Account Activity links to `/logs`. It provides All/Launches/Wallets tabs, search, time filtering and Trades/Runners/Launch Funding/Wallets Funding/Rescue/Withdraws/Shield/Archive categories. The navigation requested `GET /history`; the settled feed rendered historical entries. This does not validate their accounting accuracy.
- `/wallets?chain=sol` renders wallet folders, search, Create/Funding/Withdraw/More actions/Export wallets controls and Balance/Volume/P&L/Launches/Funding columns. More actions exposes Generate Activity, Delete and Manage, disabled with no selected wallets. Generate Activity was not invoked, so its preparation/execution contract remains unknown.
- The existing live launch workspace renders My Wallets/Latest Trades/Holders/History/Bubble Maps views, Market/Limit/Grid trade tabs and runner Configure controls. Holders and History view switches completed. Requests included `/wallets/watch/list`, `/wallets/get/sol`, `/charts/{launch}/subscribe` and `/history/launch/{launch}`. These observations do not establish complete holder coverage or a chart stream protocol.
- The page loaded TradingView charting-library assets. Chart rendering, market-data integrity and worker/frame execution are not proved by the main-document execution sample.

## Execution evidence

An eight-second REA precise-coverage window completed from 21:18:37.568 to 21:18:45.569 UTC, with instrumentation cleanup confirmed. It retained coverage for twelve scripts and 933 function records with at least one positive range count. This is a window-scoped count of records, not unique original functions or a percentage of total app behavior. Precise instrumentation affected optimization and timing.

Repeated requests to autosell/autobuy/volume/sniper-guard/cleanup status endpoints had producer-reported initiators named `getAutoSellStatus`, `getAutoBuyStatus`, `getVolumeStatus`, `getSniperGuardStatus` and `getCleanupStatus`. Launch info had `getLaunchInfo` and `queryFn` initiators. Automatic POST requests to `/launch/buyback/info/{launch}` were associated with `getBuybackMax`; no buyback execution action was clicked. Initiator association does not prove UI causality or server implementation.

The captured live main-script digest is `7440ec24b3045d3b56c0ed1864fb2cb2c9ba310c4b3704b295b0b5c0c2214451`, matching the previously recovered `index-ZhAV7deG.js` artifact. A separate six-second passive sample observed successful status responses with value-free JSON shapes: `status:string`, and sniper guard also `is_live:boolean`. Buyback-info shapes included `wallet_sources` as an object or string array, and response fields `eligible_wallet_count:number` and `max_buy_amount:number`. Actual values, headers, cookies and raw payloads were not captured by passive inspection. No WebSocket connections appeared in that attach window; prior connections and unobserved origins remain unknown.

## Evidence and limits

- Target discovery: `ev_8c755a01f3747fa116e37b9ee05fc31e5207d86ce891e8a1e2e939706c93d7be`.
- Activity navigation: `ev_d5b88071956ad0bf2e500742abba4efd7a7a5cc7df45a1e17b3f7488ad161aa8`.
- Wallet workspace: `ev_e99f9acc8f0c60ccb06cf8e31d5b640d22ed27a9c0b13a733a0c8a9e19d32012`.
- Wallet actions: `ev_0c5e4e0ba9fdc1b7a7a0b04c570d312f78d041e51bc5ed47780f0374d3a111c2`.
- Live launch: `ev_1ceb3cb68be7acba105e984bf2c73ff9fb04dd9098001ea45c072c64575facd5`.
- Holders/history switches: `ev_8308b9f630b3132a3ff0f28bdba8a8056cfeaefe546d4f299795a89d7bc43d27`.
- Precise execution: `ev_7a55137513cf00d27a7cf455b0cf51aa12ab8c9a8415671a695fae7e602bd5e9`.
- Passive JSON shapes: `ev_8a19177af2a2ea4f66674c08b964166458c2e812ab55584cfd648925744eb456`.

The complete execution response exceeded MCP's transport limit; the result remained retained. The final canonical session export is `/opt/rea/results/proxima-live-reopened-final-evidence-20261012.json` (155,949,391 bytes, 28 records). Its zero top-level unknown-record count does not remove analysis unknowns. A selected execution summary is saved at `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261012\live-reopened-execution-summary.json`. Keep canonical evidence private: accessibility captures contain account-specific history and wallet display information.

This closes the browser-connectivity blocker and establishes additional live client/runtime evidence. It does not establish backend key custody, signing, atomicity, automatic execution, durable monitoring, accurate P&L or full holder coverage. The earlier whole-bundle semantic limitations still apply. Bundle application files and Claude-owned files were untouched in this pass.
