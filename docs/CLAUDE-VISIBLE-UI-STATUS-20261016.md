# Claude visible UI pass — status

## Codex verification continuation, 18 October 2026

Current state: isolated candidate checkpoint, **not merge-ready**. Final client-shell browser proof is pending.

Canonical source baseline is main `f6800ad` (product source `e5bd8cf`), followed by documentation-only release record `d817645`. Codex verified that the four base UI files are unchanged from this branch, and applied this preserved patch to an ignored current-source copy for testing. No environment files were copied. The release owner was told to exclude this UI patch. No funded action, provider change, signing, push or deploy belongs to this UI pass.

Opus 5.5 owner session `8b2f1c6d-350a-4f9f-9f09-895f216a207b` explicitly approved Codex preparing a verified isolated UI commit with the four preserved files and this status note. The owner also approved appended desktop compact CSS to correct the source-line margin, stack the trade tape when the market pane is at most 1000px wide, and increase the scrolling chart cap by 20px. No Haiku model or fallback was used.

Before appending the follow-up CSS in this worktree, Codex records its exact UI scope: `app/ux.css` only, scoped desktop compact overrides. The three preserved TSX changes remain Claude's layout work; no further logic or handler edits are planned. Existing section rules will not be reordered or rewritten.

Measured component-only fixture with the approved three corrections: no page horizontal overflow at 320, 375, 768, 1100, 1101, 1280, 1440 or 1920px; the unchanged 310px SVG fits completely inside its pane at all sizes. At desktop 900px height, chart pane is 282.7..842.7px and wallet section begins 856.7px. This means wallet navigation starts near the fold, not that the whole wallet table is visible. Short desktop viewports still require page/workspace scrolling. Below a 1000px market pane the trade tape is reachable below the chart rather than beside it. Phone and full-page layout rules are unchanged by the desktop overrides.

Codex removed the fixture's extra `main section { margin:16px 0 }` rule before final measurements because it adds layout that the product does not use. A separate fixture mounted the actual current `app/page.tsx`, including the real sidebar and workspace classes, using synthetic account/provider responses. It is a client-shell layout check, not an authenticated Next.js production session. That stronger check found another conflict: `.workspace` imposes 40px minimum buttons, defeating the compact 30px toolbar and clipping the plot again at 1440px (plot bottom889.2, pane bottom870.7). The final appended correction explicitly restores 30px desktop compact toolbar targets with 4px vertical padding and 20px line height. It does not change phone target sizes or any event handler.

**Pending before integration:** browser verification of that final shell correction, and current-source build verification. Automatic approval review rejected the command to restart the isolated QA server and reconnect the existing Chrome CDP session; its only stated reason was `blocked by policy`. Codex did not retry that command or switch methods to evade the rejection. Earlier browser component matrix and drawing-tool reachability pass remain valid for the preceding candidate, not proof of the final shell correction. Do not merge or label this UI ready until the final correction passes the client-shell desktop/phone matrix. The last synthetic fixture had all signing and provider submissions disabled.

Offline verification on current source: the three existing UI test files pass all six tests; scoped typed lint passes. Additional final checks are recorded below as they finish. Screenshots and raw measurements are ignored local artifacts under canonical `output/playwright/` and `work/claude-ui-layout-matrix-result.txt`; they are not production evidence.

Final current-source offline rerun after copying the exact formatted candidate: all three existing UI test files/six tests pass, plain TypeScript and scoped typed lint pass. Established CSS rules remain byte-identical before the appended block; the end-of-file newline is added so the new block is separate. No assertion of production parity or complete wallet-table visibility follows from these checks.

An additional TypeScript AST/printer comparison against canonical main `d817645` verifies identical multisets of all 56 JSX event attributes, 83 disabled/checked/required/value/aria attributes and 146 functions without JSX rendering bodies across the three changed components. This supports unchanged event bindings and guards; it does not replace browser reachability or visual checks. The local hashed comparison report is `work/claude-ui-bindings-review.json` in the canonical checkout.

The final isolated current-source Next.js webpack production build completed successfully, including TypeScript and static page generation. It used no copied environment file. It emitted the existing external parent-lockfile warning and an additional nested-scratch workspace-root warning; no root tracing/dependency settings were changed to hide them. This is a build of the current product source plus the exact UI candidate, not a production deployment or a build of the historical branch's backend.

16 October 2026. Worktree `C:\Users\Julian\Desktop\Bundle-Claude-UI`, branch `claude/bundle-ui-20261016`. Model: Opus 5.5. Task: `docs/CLAUDE-VISIBLE-UI-TASK-20261016.md`.

## State: ready for Codex verification

All edits are uncommitted. Nothing has been pushed, merged or deployed. No environment, provider, credential, dependency, backend, signing or wallet files were read or touched.

Codex confirmed the dirty set: `app/ux.css`, `components/imported-pool-candles.tsx`, `components/imported-token-market.tsx`, `components/imported-token-projects.tsx`, and this note.

## Changes

### `components/imported-token-projects.tsx`

- The page-title intro paragraph only renders when no token is open. The heading stays.
- The token details now start with a compact `header.imported-token-header`:
  - Left side: name, the chain/state/revision line and the address.
  - Right side: the existing Refresh/Archive (or Restore)/Close buttons, the "Open token chart and supply workspace" button, and the Keep chart visible / Full page review toggle.
- Every button label, handler, disabled state and `aria-pressed` value is unchanged.
- The identity/supply disclosure follows the header, unchanged.

### `components/imported-token-market.tsx`

- New order: heading, stats strip (unchanged), pair/refresh/feed toolbar, feed status, then the archived, unsupported, loading, error and empty notices, then the chart board.
- The read line (source, read time, revision, n/20) and the "Market data coverage and feed behavior" disclosure now render below the board. The disclosure text is unchanged.
- The "Market observations and conditions" disclosure stays below those. Its content is identical; I only removed redundant fragment wrappers.
- Fetching, the feed controller, `accept` validation, `usePublishPairMarketSelection` and keys are untouched.
- Added class hooks only: `imported-market-feed-status` and `imported-market-read-line`.

### `components/imported-pool-candles.tsx` (`PoolCandleChart` only)

- Save/Restore drawings, the storage message, and the guide/trend buttons plus the Add guide form now sit inside a collapsed `<details className="candle-chart-tools">` titled "Chart drawing tools".
- It sits after the visible candle-inspection select and OHLC readout.
- The disclosure is uncontrolled, so it stays open once the user opens it.
- Still visible:
  - Zoom and window controls.
  - The price/market-cap scale toggle.
  - Candle inspection.
  - Active guide/trend status messages and the trend/guide remove buttons, which render above the chart.
- No handler, state or aria label changed. The existing test clicks buttons through `querySelectorAll`, which also finds buttons inside a closed `<details>`.

### `app/ux.css`

One block appended at the end, starting with the comment "Token workspace density pass (Claude visible UI, 16 Oct)". No existing rule was edited or reordered.

- Compact page title when a token is open, scoped with `:has(.imported-token-details)`.
- Header layout. Below 700px the action column stacks full-width and left-aligned.
- Muted 12px styling for the feed status and read line, and summary styling for the drawing tools.
- Under `@media (min-width:1101px) and (min-height:640px)`, compact workspace only:
  - Smaller gaps and padding.
  - Compact stats strip and 30px toolbar buttons.
  - The chart section's `max-height` becomes `clamp(540px, calc(100dvh - 330px), 780px)`, so the wallet row (grid row 2) starts higher on screen.
  - The trading column keeps its existing `clamp(340px, 22%, 380px)` width, row span and scroll.

## Expected effect

These are estimates; nothing was rendered.

- At 1920×900 in compact mode, the header and page chrome should take roughly 300px. The chart pane is capped near 570px, and its 310px candle plot should stay fully visible at the top.
- The wallet section should begin near or just under 900px. The rest of the chart pane scrolls inside it, as the existing compact design already does.
- At 375px, the existing ≤1100px single-column stack still applies; the new rules only add wrapping, and none sets a fixed width.

## Not verified (no shell in this session, by instruction)

- Formatting: indentation inside the new `<details>` in `imported-pool-candles.tsx` needs Prettier.
- TypeScript, lint and tests: none were run. Relevant tests are `components/sol-candle-chart.test.tsx`, `components/imported-token-market.test.tsx` and `components/pair-market-workspace-selection.test.tsx`.
- Desktop 1920×900 and 375px phone rendering, including the actual top of the wallet row and any horizontal overflow from the header button rows.
- `:has()` support in the target browsers. If `:has()` is unsupported, only the page-title compaction is skipped.

## Follow-up pass after Codex render feedback

Source: `docs/CODEX-CLAUDE-UI-RENDER-FEEDBACK-20261016.md`. Same four files, all still uncommitted. No behavior, handler, label, fetch or safeguard changed. This pass touched only `imported-token-projects.tsx` and `app/ux.css`, and only inside my appended block.

### Issue 1: plot clipped at 1920×900, wallet section started at 941px

Measured problem: the plot ran from 657 to 967px, while the pane ended at 895px.

I did not shrink the plot. It stays 310px with unchanged geometry. Instead I reclaimed space from the surrounding rows:

- **`imported-token-projects.tsx`:** the "Token identity and supply" disclosure moved inside the header's left column, under the address. That removes a full row above the workspace. The content is identical.
- **CSS, compact desktop only:** the "Market observations" h3 and "Pool candlesticks" h4 are visually hidden but kept for screen readers. The stats strip and toolbar already label the pane.
- **CSS, compact desktop only:** the stats strip is tighter (padding 6/12, dt 10px, dd 15px, source line 11px). All five values and the source/stale disclosure are still shown.
- **CSS, compact desktop only:** the candle labels ("Price currency", "Candle interval") now sit inline beside their selects instead of above them. They were grid labels, which stacked text over the select. This should bring the candle toolbar from 60px down to one 30px row.
- **CSS, compact desktop only:** the feed status line is 11px/16px, and the "Explore the chart" summary has no margin and 18px line height.
- **CSS, compact desktop only:** the pane cap is now `clamp(530px, calc(100dvh - 360px), 780px)`, which is 540px at 900 tall.

Estimate, derived from Codex's measured offsets and not rendered:

- The pane should start around 305px.
- The plot should end around 820px, inside a pane that ends around 845px.
- The wallet section should start around 890px.

If the candle toolbar still wraps to two rows, the plot gains about 30px and the margin is lost. The next step would then be to lower the clamp minimum or narrow the candle button text.

### Issue 2: page overflow at 375px (scrollWidth 390)

Cause: grid labels (`.wallet-warmup-panel label { display:grid }`) gave a long-option select an intrinsic minimum width wider than the column.

Fix, scoped to `.imported-live-workspace`:

- Labels get `min-width:0; max-width:100%`.
- Grid labels get `grid-template-columns: minmax(0,1fr)`.
- Selects get `min-width:0; max-width:100%`.
- The pair select keeps its existing 320px cap as `min(320px, 100%)`, so desktop width is unchanged.

The wallet tables' own internal horizontal scroll is untouched.

### Still unverified here

Rendering, measurements, formatting, tests and typecheck are all unverified in this session; Codex owns them. Please re-measure:

- The plot bottom against the pane bottom.
- The wallet section top.
- Whether the candle toolbar fits on one row.
- scrollWidth at 375px.

## Possible follow-ups (not done)

- If the wallet row still starts below 900px, lower the chart-pane clamp minimum (540px), or move the stats strip into the toolbar row.
- I did not propose an `app/page.tsx` patch.
