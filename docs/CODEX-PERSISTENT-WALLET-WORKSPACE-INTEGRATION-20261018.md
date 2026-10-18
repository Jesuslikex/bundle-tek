# Persistent token chart and wallet workspace

18 October 2026. This implements the reviewed workspace proposal on canonical Bundle source. The original proposal and patch remain historical artifacts, not the final diff. Local only; Proxima parity remains incomplete.

## Behavior and ownership

The selected token keeps its chart, quote column and lower wallet views together when measured desktop space permits. My wallets, Supply and alerts, Holders and Activity switch without unmounting their contents. Hidden content changes get an Updated marker and a polite shared announcement, neither an alert count nor a read receipt. Full page review exposes all panels. Narrow or short layouts use normal flow instead of clipping the plot to force a dock.

The wallet inventory appears before the longer selected-wallet review. A successful existing Buy/Sell review selection reveals My wallets, opens the review, scrolls within the wallet panel and focuses its summary. Existing locked/unavailable-wallet refusals remain. Filters and long explanations move into a disclosure; errors, stale notices and public-balance warnings remain visible. HTML or malformed roster responses show a useful reload message instead of parser text. Selecting a public address does not unlock its signer.

The unchanged picker/actions move into the selected token header. The full 310px plot remains; unchanged chart help and feed status move below it. Short visible toolbar labels retain descriptive accessible names containing those labels. Identity, stale observations, provider coverage and chart inspection remain available.

The original Claude author reviewed the exact protected composition and bounded candle/market patches using Opus 5.5 before implementation. Label-in-name corrections were applied. This checkpoint does not edit app/page.tsx, quote/sell presets, APIs, providers or migrations. Financial callbacks, disabled gates and selected-market publication remain; presentation navigation follows original wallet validation. This is scoped source/test evidence, not whole-program financial equivalence.

The frame cleans up observers, animation callbacks and listeners. Tabs use roving focus and Arrow/Home/End keys, with useId identifiers. Existing state/timers remain mounted; project/revision/handoff reset boundaries remain. The frame adds no provider calls or polling and does not automatically start monitoring.

## Actual app evidence

Used the normal signed-in app at https://localhost:3443, existing Chrome profile, ROADSTER import and saved public wallet. Existing trusted local TLS and transaction-blocking helper retained. Earlier public market/candle observations were reused; stale labels remained visible. No feed, quote, scan, preparation, signature or submission was activated during layout checks.

| Viewport                 | Result                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1920×911 normal viewport | Docked frame163–869px; full310px plot ends615px; wallet panel639–869px; first real row788.5–857.5px,69px tall. Document width1920px. |
| 1440×945                 | Full310px plot; first row802.5–899.5px,97px tall; wallet panel ends903px.                                                            |
| 1440×900                 | Flow fallback intentionally requires page scrolling. Narrow desktop rows need264px reserve rather than wide desktop224px.            |
| 375×812                  | Flow; full310px plot; document client/scroll width360/360px with scrollbar.                                                          |
| 320×812                  | Flow; full310px plot; document client/scroll width305/305px with scrollbar.                                                          |

The grid containment fix prevents wallet content extending outside its assigned area. These results do not claim every desktop size shows a table above the fold. Activity/Holders/My wallets switching and selected-wallet focus were exercised in the actual app. Ignored screenshots: work/persistent-workspace/live-qa/desktop-1920.png and phone-375.png. Temporary viewport overrides are reset after checks.

## Validation and limits

Seven related files/20 tests pass: mounted state/timers, keyboard/IDs, hidden updates, measured fit/fallback, wallet review focus/refusals, malformed-roster recovery, table/chart controls and selected-pair publication. Plain TypeScript and scoped typed lint pass. Final build after the narrow-row reserve correction exited0: compilation27.2s, TypeScript9.7s, six static pages1111ms and traces complete. Source was held by both chats for that build. The existing trusted helper was restored afterwards. Final compiled-source browser checks reproduce the1920×911 and1440×945 measurements above, and1440×911 correctly uses flow with the310px plot intact. Temporary viewport overrides are reset; the final local tab remains open for review.

The separate 4,971-test baseline predates this UI and newer strategy/preference source; it is not a final-source full-suite claim. Complete holder coverage, audited P&L, funded execution, stock signing qualification, marketplace delivery and remaining launch/funding work remain separate gaps.

No push, deploy, hosted SQL, provider/credential/cron change, wallet unlock, signature or funded transaction. Other chat files are excluded from this checkpoint.
