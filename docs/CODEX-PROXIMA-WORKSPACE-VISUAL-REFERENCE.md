# Current Proxima workspace visual reference

13 October 2026 local time. Investigation used the existing user-approved dedicated Proxima CDP browser. No trade, funding, withdrawal, reward claim, purchase, key export or transaction submission control was invoked. Bundle source remained frozen during the earlier full-suite handle 49396 and the current handle 72422.

## Observed image and layout

Verified screenshot: `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261012\token-workspace-827x640-20261012.png`. Its SHA256 is `4bdf78d3d3a3d4f0be31fd60adaaa5ef7dc5c617ce9604a9a15f2cba37d08041`; actual captured viewport is 827 by 640 pixels. Capture timestamps use UTC, while this note uses the local date. It shows the existing DINGER workspace, not Bundle or a reconstructed mock.

The visible reference places a narrow icon/sidebar rail at left, token/volume information across the top, chart and trade tape beside each other in the upper left workspace, wallet navigation/table underneath, and a persistent trading pane on the right. The lower-left navigation includes My Wallets, Latest Trades, Holders, History and Bubble Maps. The right pane displays Market/Limit/Grid navigation, Buy/Sell selection, holder/deployer percentage controls, bought/sold/holding/unrealized-result metrics and a disabled reward control. Visible amounts and trade data are account/provider observations, not independently audited P&L or proof of strategy execution.

The chart split is unusually narrow in this saved layout. A first immediate screenshot showed an incompletely populated chart; the retained later screenshot shows candle rendering. Do not infer an absent/broken chart from the first capture or copy the narrow saved divider as a canonical requirement.

## Viewport limitations

An attempted 1440 by 900 scenario completed navigation, but a separate post-scenario screenshot still measured 827 by 640. A subsequent image captured inside the configured scenario had a larger raster with the existing narrow workspace concentrated at its upper left. It does not prove the app reflowed at a real desktop width. Correctly sized screenshot output alone is insufficient evidence of responsive layout.

The user has now maximized the same dedicated browser. A fresh passive screenshot verifies an actual 1920 by 945 viewport, with the populated workspace using the desktop space. This supersedes the narrow-window reference limitation; phone behavior remains unverified. No alternate browser/authentication session was opened.

## Verified maximized desktop reference

Saved image: `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261012\token-workspace-1920x945-20261013.png`. Exact screenshot evidence: `ev_1ebfdb9ac3802accf03aaf63457edb07cffdd6f18f4b4db94a6231df68de8722`, captured at `2026-10-12T23:57:39.308Z`. PNG size is 274,678 bytes and SHA256 is `540df3980e72a45b3d9b6e04ac94c43b3b1793847b8196b635cc5b067846bf4b`. The passive capture did not scroll, navigate or evaluate JavaScript.

The maximized image shows a dominant chart, a substantially narrower tape beside it, the wallet table below both left panes, and a separate trading pane at the right. My Wallets/Latest Trades/Holders/History navigation sits above the wallet area. The right pane retains trade mode controls, bought/sold/holding/uP&L figures and runner sections. Chart overlays labelled Average Buy Price and Average Sell Price are visible; their displayed values and calculation methodology are not independently reconciled. This single desktop observation does not establish all divider states or responsive breakpoints.

The current Bundle chart/tape adjacency follows this structure. After the combined suite completed, its tape width was bounded to 230–300 pixels, with a preferred width of 20% of the containing market pane. The chart receives the remaining space. This supersedes the prior proportional tape column; Bundle's actual desktop rendering still requires verification. The screenshot is a reference, not proof of Bundle rendering or full feature parity.

## Comparison with current Bundle source

`components/imported-token-projects.tsx` offers an Open token chart action, compact/full-page controls, chart/market content, transaction review, the protected supply tracker and the indexed holder panel. The current local change places the existing candle chart beside a compact trade tape when their container is at least 640 pixels wide. Narrower containers stack them. Market-analysis details follow that board. A parent wallet/holder wrapper sits beneath the left market pane in the compact desktop workspace while the reviewed trading pane spans the right side. At widths at or below 1100 pixels the whole workspace stacks.

The compact tape retains side/time, USD volume and sender/transaction columns; original amounts, price, timestamp and block remain available in Exact values, and movement inspection remains accessible. The chart and tape retain one instance each, their existing data handlers and the chart's resize observer. Claude's supply-tracker and holder implementations are untouched. This closes the source-layout adjacency gap; it does not establish full Proxima workflow parity or Bundle's rendered appearance. Wallet/history navigation, current desktop/phone interaction and live-feed freshness still require direct verification. Seventeen focused chart/tape/movement tests, TypeScript and scoped lint passed. Source CSS and static markup tests cannot prove rendered behavior.

## Retained evidence

The final production build passed after removing the obsolete compact-pane row override. Build log: `work/release-qa/proxima-workspace-build-final-20261013.log`. Combined full-suite handle 72422 completed with exit code 0: 284 files and 1,891 tests passed, 17 files/tests skipped, zero failures, duration 1,355.96 seconds. Its 983-file source snapshot `work/release-qa/source-workspace-final-20261013-0052.json` remained unchanged through completion, digest `554be58fd7e12c70ad731c4722691acd7e417c57ec7816016cab79531bc3d0b3`. Report/log prefix: `work/release-qa/full-suite-workspace-20261013-0052`. This verifies the integrated expense/schema/layout source at that snapshot, not funded execution or rendered UI. The subsequent bounded tape-width CSS change is later source and is not covered by this full-suite result. The earlier 00:50 snapshot predates the final CSS correction and is not the run's source identity.

- Fresh target discovery: `ev_7399bccbae6315f4486d80281a16b1429c37a3632e77755559896424d4cbfb3f`.
- Return to the exact existing token workspace: `ev_950b49bd7a3a1b1d66da0749741a0e8de6577001d22a56c4427504c386b64014`.
- Observed 827 by 640 screenshot: `ev_42e6daf2ec3d8a4a1eec6fa63f8746c510215e34be3036d9957434e4b20d8578`.
- Requested desktop-size navigation: `ev_c5b54be7210f9e89f30b8703ca4c7d6ec044182a7569226caff4217bcf4c6765`.
- In-scenario larger-raster check: `ev_0b7fd86d1f08c447dd6e034a0dacc5d572e5b77b91096acd97463b2980557e42`.

The first four records are retained in `/opt/rea/results/proxima-workspace-visual-evidence-20261012.json` (50 session records, 228,973,872 bytes). This includes earlier investigations and its zero top-level unknown-record count does not imply complete semantic analysis. The larger-raster check was captured after that export and remains in the REA session. Saving the image through an inline base64 JavaScript call was rejected by automatic review for exceeding its 64 KB input limit. The safer retained-evidence file operation selected the exact screenshot record, verified its digest and wrote the PNG with exclusive-create semantics. No screenshot data was added to Bundle's public files or deployment package.

The maximized screenshot and recent token-history navigation evidence are retained in `/opt/rea/results/proxima-maximized-workspace-evidence-20261013.json` (56 records, 231,014,451 bytes). The exact PNG was extracted from that record with digest verification and exclusive-create semantics. The export includes prior investigations; zero top-level unknown records is not semantic completeness.

The later bounded tape-width production build completed with exit code 0. Log: `work/release-qa/proxima-bounded-tape-build-20261013.log`. Actual Bundle desktop/mobile rendering remains unverified.
