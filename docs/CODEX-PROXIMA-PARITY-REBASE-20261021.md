# Proxima parity: current source and evidence baseline

21 October 2026. Inspected committed source: `bfb6a19b6c6c799ae262786f22872e181bcc77e4`. This replaces neither historical evidence nor the full product goal. It corrects stale open-item descriptions and defines the evidence still needed. It does not certify production, transaction execution or full parity.

## Reference coverage and connection

The approved dedicated Chrome profile still exposes Proxima at `/account`. Restarting the existing temporary loopback/stdio WSL relay restored REA access without launching Chrome or changing its profile. Target-list evidence: `ev_a000a5867b2c0bbec3024e702acb0e47e0db2708297382cb507207dcff7533aa`. Passive account-page evidence: `ev_2d1f653413cb596049cdabc510886a87093b8c5a50a08f3d35bb361f7abd47a5`.

That account view exposes period controls, cumulative/daily P&L, win rate, chain breakdown, calendar and recent/best launch views. Their presence is observed; their accounting correctness and backend architecture are not. No personal account values, wallet addresses or private launch names are reproduced here.

The full retained two-record bundle is private at `/opt/rea/results/proxima-parity-account-20261021.json`, 241837 bytes, SHA256 `be99a9ab20d74fbefdf7abde72e2e0d2c2dd91820f774fe55bc64b2413a25117`. Zero retained unknown records is not complete feature coverage. Capture was origin-filtered, attach-limited for prior events and excluded script sources, cookies, raw payloads and storage values. The account capture does not refresh the warmup, trading or launch screens.

The temporary WSL relay was stopped after export. Its noninteractive shell had closed stdin, so its exact verified Python listener PID was terminated; the owning Node session ended and the WSL listener disappeared. Windows Chrome's original loopback listener remained open. No user browser was stopped. Separately, ordinary Chrome computer-use inventory still timed out. Final rendered Auto Sell status/outcome QA therefore remains open; the REA repair does not resolve that separate control failure.

Current official references checked on this date:

- [Generate Activity](https://docs.proxima.tools/wallets/generate-activity/): selected-wallet buy/sell loops, amount/range, loop count, delay, required balance/time, progress/cancellation and optional Axiom routing with an extra cost. Those are documented semantics, not a verified backend implementation or an independently verified trade history.
- [Auto Buy / Auto Sell](https://docs.proxima.tools/live-settings/auto-buy/): Counter, DCA and Limit strategies, combined configurations, trade filters, replication/accumulation, strategy/session endings and lifecycle controls. Matching controls does not prove correct execution.
- [Activity](https://docs.proxima.tools/settings/activity/): account-wide and focused histories with scope, search, date/network/category filters and event detail. Loaded pages must not imply complete account history.
- [Documentation index](https://docs.proxima.tools/): use its remaining sections as the breadth checklist below. Navigation presence is not functional proof.

## Corrections to the older checklist

1. **Saved-buy runtime Sell composition exists.** `wallet-warmup-session-v2-runtime-provider.ts`, `wallet-warmup-runtime-receipt-floor.ts`, the native runtime Sell tests and `CODEX-WARMUP-RUNTIME-SELL-20261021.md` cover full and partial retained lots, the real inventory observer, exact unsigned runtime observation, immutable saved recovery and source races using declared synthetic providers/SQL. It is still not a live provider or funded qualification. Do not repeat the earlier runtime UI note's statement that this source composition is absent.
2. **Warmup session history is not an executing session.** V2 journal and runtime DTOs explicitly keep signing, execution and automatic execution false. The UI offers manual quote/simulation or runtime reads and same-ID recovery. A saved history control does not schedule or submit a buy/sell loop.
3. **Auto Sell is a different path.** Its tab-local runner calls the existing browser executor after approved session setup. It is not accurately described as entirely read-only. It still lacks funded proof and durable autonomous orchestration. Submitted/unknown amounts are accounted conservatively, not proven sales. The latest outcome lookup reads saved approval status only, never reconciles counters or proves finality.
4. **Marketplace is beyond a static catalog, but is not a working checkout.** The current workspace mounts operator drafts, inventory and buyer hold/recovery. The actual buyer dialog explicitly says payment, purchase and secure key delivery are unavailable. Founder-only supply does not solve retained-key ownership or delivery assurance.

## Product completion checklist

Each row remains open until the actual current source, rendered flow, API/data boundary and appropriate runtime evidence support its full scope. Existing filenames or a historical green suite alone cannot close a row. No new production state was queried in this pass.

| Area | Current source entry points / bounded evidence | Evidence required before parity claim |
| --- | --- | --- |
| Account, settings and dashboard | Account/performance components and API; current Proxima account capture above | Signed-in desktop/mobile navigation, session/error recovery and independently reconciled fee/transfer/coverage-aware metrics. Verify saved settings and period semantics. |
| Wallet creation, folders, backup and preparation | Wallet workspace and warmup components; earlier generated-wallet public-read evidence | Current create/save/backup/restore-to-warmup flow, exact ownership/selection, empty/locked/stale states and user-controlled key handling. No fresh secret access in this audit. |
| Generate Activity / warmup | V2 consent, journal, read modes, runtime adapter and receipt-floor composition | Current provider qualification, reviewed program policy, shared reservations, short authorization, one-send/finalized-or-unknown recovery, exact action/budget advancement and durable session orchestration. Qualified alternative routing remains separate. |
| Auto Sell and Auto Buy | Auto Sell modal/runner/executor; Counter/DCA/Limit helpers and pause/edit/status/outcome tests | Final status/outcome rendered QA, provider/execution and interruption qualification, exact strategy/session semantics, durable recovery and an explicit Auto Buy audit. Do not infer Auto Buy execution from Auto Sell or Counter preview. |
| Other automations | Volume Bot and wallet cleanup components/services | Verify actual supported networks, units, scheduling and stopping. Project market redistribution and wallet account cleanup are different features. Funded/automatic execution needs its own proof and authorization. |
| Token workspace and trading | Imported market, quote/wallet, supply/holder/history and conditional components | Current selected-pool chart/tape/order workflow, responsive layout, error/coverage states and receipt-bound trade proof. Holder completeness and trader attribution need provider evidence. |
| Stock pairs | Order-first review and stock signing policy boundary | Repeatable SOL/USDC qualification with unchanged 32-slot span, both scans and all custody/Clock/minimum checks, then separately approved signing integration. A configured paid RPC alone proves none of these. |
| Launches, cloning, import, currencies and venues | Launch forms, metadata/artwork, clone lookup, venue-specific and Pump group components | Per-network/venue capability matrix, actual configuration/fees/program identity, image/metadata reachability, exact approved packets and receipt recovery. A venue card is not live execution. |
| Launch funding, block-0 layers and protection | Exchange quote/order/payout, launch-layer and sniper components/APIs | Qualified provider deposit/payout evidence, independent transfer accounting, exact funding shortfall/fees and reviewed layer/protection execution. No inference about Proxima's undisclosed backend provider. |
| Post-launch operations | Liquidity, withdrawal and other owned operation panels/APIs | Individually audit supported send/burn/lock/rewards/liquidity/recovery flows, authority, network/venue limits, approval and receipt handling. Do not mark all present from one panel. |
| Wallet marketplace | Workspace, seller console, inventory/drafts, buyer reservations/history | Qualified honest inventory, price/age/provenance semantics, publication policy, payment/order recovery and secure delivery model. Holds are not purchases or exclusive custody. |
| Activity and tracker | Workspace activity hooks, public watchlist and movement/supply readers | All/focused scope, date/search/network/type filtering, pagination completeness, actionable event details, skipped/failed/unknown distinctions and restart/error behavior. Warmup session metadata and local Auto Sell logs must not be mistaken for finalized transactions. |
| Collaboration, instant trading, referrals and support | Explicit source/behavior audit still required for each documented flow | Inspect current Proxima pages and Bundle implementations before classifying implemented/missing. Verify permissions and recipient scopes, shortcuts, responsive behavior and failures. No whole-repository negative claim is made from a filename search. |

## Next work, in order

1. Finish the owned Auto Sell status/outcome rendered checks when the existing Chrome connection returns. Use synthetic public fixtures and blocked signing/provider transports; do not unlock a wallet to test a layout.
2. Evaluate the focused actual Opus 5.5 review of current warmup/Auto Sell code. Independently reproduce concrete findings and commit each verified correction. It is a source review, not browser/provider or full-product approval.
3. Continue warmup operational prerequisites in dependency order, retaining all false authority gates until their real requirements pass. Do not add a Start button that only saves metadata or weaken a runtime check for apparent parity.
4. Refresh the remaining reference screens and measure their actual workflow against the breadth checklist. Keep protected Claude shell/layout ownership separate; use exact proposed patches where required.

This checkpoint does not run application/hosted SQL, migrations, provider configuration, credentials, cron, deployment, wallet unlock/sign/send, strategy execution or funded tests. Git publication shares source and this handoff only. Full Proxima parity remains unproven and the goal stays active.

## Actual Opus 5.5 operational review

The first read-only review completed 17:22:28Z–17:26:41Z, explicitly requested/selected/used only `claude-opus-5-5`. All 3424 copied files stayed unchanged, with zero permission denials, edits or tests. Original log/status: ignored `work/release-qa/opus-parity-operational-bfb6a19-20261021/`. Codex is responsible for verification; this reviewer did not run a browser, provider or test suite.

Its strongest finding was independently reproduced: a context remount/unmount could release Auto Sell's browser lock while an original operation was still settling. The narrow pending-lock fix is documented separately in `CODEX-AUTOSELL-PENDING-LOCK-20261021.md` with baseline failures and passing correction evidence. This fixes neither the full lifecycle nor all findings.

Remaining findings to verify or address:

- Original outcome entries can disappear on remount or log truncation. Pinning and durable discovery need explicit scope/ownership; saved approval status must not reconcile financial counters or prove finality.
- Warmup's first-action-only journal/attempt rules remain an intentional incomplete execution boundary. Adding a cursor requires a reviewed lifecycle, real receipt/budget admission and immutable migration sequencing; a cosmetic next-step control cannot replace this.
- Parent Pause/Stop can invalidate an in-flight read attempt; the reserved attempt may remain charged and unresolved until recovery/expiry. Check whether the UI makes that consequence clear without blocking Stop.
- The warmup wallet-busy advisory needs an explicit audit against imported/manual signing intents and shared reservations. It is not an exclusive financial reservation or proof that no wallet work exists.
- The warmup step label must distinguish available runtime observations from unavailable execution qualification.

Opus proposed skipped-action advancement as one possible next slice. That proposal is not accepted or implemented here: recorded skips must not be used to present an executing buy/sell warmup loop as complete. Its review did not read the full Counter evaluator, feed, consent/view parsers, runtime order collector or receipt-floor helper, so those domains are not independently cleared by this review. Its broader wording about missing warmup execution does not negate the existing saved-buy runtime Sell composition above.

## Saved-outcome discovery follow-up

`CODEX-AUTOSELL-OUTCOME-DISCOVERY-20261021.md` and its portable evidence now cover a separate bounded reminder list and explicit saved Sell history browsing/recovery after local entries disappear. This supersedes the earlier assertion that the rolling log is the only route to those saved approvals. It does not make reminders durable, restore a missing local signature, classify every record as Auto Sell, reconcile counters or prove finality. The existing authenticated GET, signing/financial rules and false authority flags are preserved. Rendered desktop/phone verification, durable execution and the broader product checklist remain open.
