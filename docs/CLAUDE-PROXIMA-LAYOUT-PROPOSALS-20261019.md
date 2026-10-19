# Proxima layout proposals for Codex-owned screens, 19 October 2026

julian asked for Bundle's UI/UX to match Proxima. Claude shipped the shared shell (PR #32: icon rail, Features order, collapsible Plan tools, one-row Import/Create launch, status-bar latency) and the status-bar reference prices. The remaining gaps sit in areas AGENTS.md assigns to Codex, so they are listed here as proposals instead of edits. Copy layout and flow only, never Proxima branding or assets.

Evidence: julian's saved screenshots in `C:\Users\Julian\Desktop\REA\results` (`proxima-front-back-mev-20261018-setup.png`, `proxima-deep-20261012/proxima-live-token.png`, `proxima-wallet-prep-20261012/token-workspace-1920x945-20261013.png`). Bundle screenshots were taken from `next dev` with no signed-in data.

## 1. Launch workspace after token details (launch layers, `components/launch/**`)

Proxima: once the token is set, the center becomes one dense workspace, not a long form.
- Header row: token avatar/ticker/name with copy/edit icons, Est. Market Cap range and Required Funding (SOL) tiles, Archive at right.
- Three panels across the top: **Funding Wallet** (address, Deposit/Withdraw), **Auto Sell**, **Sniper Guard** (empty state "Add Sniper Guard").
- Below: a wallet table (index, address, verified badge, role icon, supply %, buy, required, per-row actions) with Block-0 mode toggle, Create Wallets / Import Wallets / Delete in the table header and a "N Wallets, N Mev" footer.
- A fixed bottom action bar: Rescue at left, Distribute and a primary **Launch** at right.
- **Launch** opens a "Launch Setup" review modal: token identity, a grid of configuration tiles (Front MEV, Back MEV, Holders, Block-0 preset, Fake tip, Slippage, Funding type, Funding/Buy/Initial/Front+Back delays, Scheduled mode, Rewards, Creator fee, Imported, Quote), then a Wallets table with Buy and Required columns.

Bundle today: Launch Settings is a long form with mode cards and a right "Sequenced Mode" rail. Proposal: keep all existing reviewed controls and approvals, but group them into the workspace above, and render the existing review step as the tile-grid modal.

## 2. My Wallets (`components/wallet-workspace*`)

Proxima: a dense table first (folders on the left, rows with address, balance, supply, per-row quick-sell % chips and actions), with Create/Import/Fund Wallets in the table header. Bundle shows a page heading, a long notice and stacked cards before the table. Proposal: move the safety notice into a collapsible info line, put the toolbar in the table header, and give the table the full height.

## 3. Funder selector (sidebar, wallet workspace)

Proxima has a "Funder" wallet dropdown above Import / Create Launch in the sidebar. The sidebar row is ready for it (PR #32 keeps the bottom area as a grid). It needs a wallet-workspace source for the selected funder, so it belongs with Codex.

## Already matching

The token workspace (chart + tape, My Wallets / Latest Trades / Holders / History tabs, right Market/Limit/Grid pane) already follows Proxima per `CODEX-PROXIMA-WORKSPACE-VISUAL-REFERENCE.md`.
