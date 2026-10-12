# REA pass: Proxima account P&L and performance

Date: 2026-10-12. Target: static client capture `C:\Users\Julian\Desktop\REA\targets\proxima-20261009` (release `20261008-180532-376bdbe`, captured 2026-10-09). This is client-side evidence only; server computation of P&L values is not observable here.

Scope: the account performance surface only (P&L stats, charts, win rate, P&L calendar). Referral/affiliate, launch, funding and wallet-automation code were out of scope and not examined.

## Method and evidence

| Step | Evidence | Coverage |
| --- | --- | --- |
| Whole capture, `rea analyze-javascript-application` (rea-agents 6.4.0) | `ev_29a5719a953d26f9cc947a4ad2edf9f0ddc291acd702cdbda0826e9db…` (root sha256 `5c4ea605…`) | 83 files, 82 parsed, 0 parse failures. Semantic coverage partial: the parent result budget was exhausted, so semantic analysis of `PnlCard`, `TotalPerformance`, `UserPnLChart`, `WinRateChart` was not started (static facts retained). |
| Summary view | `ev_328863f42f7ccd6f8f38c7e8b99268fe232bab62183d42038de544b12…` | 146 limitations, 7,475 semantic unknowns. |
| Focused subset (10 files: account page, `TotalPerformance`, `DailyPnL`, `WinRateChart`, `PnlCard`, `UserPnLChart`, `BaseLineChart`, two `utils`, `mcap`) | `ev_4b9c4c5c3086340b34f9073f9a89c10566bb9621ef2d207d9369b76178e58823` | Semantic analysis ran for `TotalPerformance`, `DailyPnL`, `PnlCard`, `BaseLineChart`. Account page, `WinRateChart`, `UserPnLChart`, `mcap`, `utils-7vBUGaBI` still budget-limited to static facts. |
| Direct reading of the three small chart modules and the 29 KB account page | Source text of the files named below | Complete for those files. Identifiers in this build are not minified. |

Evidence JSON was written to the session scratchpad, not the repository; re-run the commands above to regenerate it.

## Observed (static)

Routing and loading:

- `/account` lazy-loads `AccountPage` from `page-2atVrC6S.js` (router in `index-C1cJCLGU.js`). `/account/launches` and `/account/archived` are separate pages.
- The account page statically imports `PnlCard` and lazy-loads `TotalPerformance`, `DailyPnL` and `WinRateChart`. `UserPnLChart` is used only from `ProximaAccountModal`.

Controls:

- Timeframe segmented control: All-Time, 1 Year, 1 Month, 7 Days, 1 Day.
- Chain selector. Currency toggle (USD ↔ chain native) appears only when one chain is selected; "all chains" forces USD.
- Two chart panels side by side; on narrow screens they scroll horizontally with two pager dots. Each panel switches between Cumulative P&L (area), Daily P&L (bars; "Hourly P&L" in 1 Day) and Win Rate (donut). Each panel's chart type persists in `localStorage`.

Stat cards:

- Total P&L (green/red with sign). Clicking opens the P&L Calendar.
- Total Launch count.
- Each shows a percentage "evolution" badge when the timeframe is not All-Time.
- Two affiliate cards (count and rate), out of scope.

Data shape and calculation:

- The unit is a launch (`mint`) with server-provided `pnl_usd` / `pnl_native`, `launch_status`, `launched_at`, `chain_id`. Drafts and launches without `launched_at` are excluded.
- Each launch's entire P&L is attributed to its `launched_at` time.
- Bucketing: 1 Day → hourly; 1 Week and 1 Month → daily; 1 Year and All-Time → monthly. Buckets are built in the browser's local time zone.
- Chart values are converted to JavaScript numbers before summing. The calendar sums raw values with `BigInt` before converting.
- Win rate, Count mode: launches with P&L > 0 are wins, < 0 losses. Break-even is counted only for finalized launches with exactly zero P&L and is excluded from the percentage denominator. P&L mode: profit magnitude ÷ (profit + loss magnitude).
- Evolution badge: (window total) ÷ |total of all launches before the window start| × 100. The comparison base is everything earlier than the window, not the preceding window of equal length.

P&L Calendar (modal):

- Monthly grid (Mon–Sun) and yearly grid of months, with previous/next limited to the range between the first finalized launch and today.
- Each day/month cell shows its summed P&L, colored green/red, and optionally a launch count ("Show launch count" setting).
- A searchable time-zone setting applies to the calendar only.
- Footer: current positive-day streak and best positive streak in the displayed period.
- Selecting a day slides in that day's launches with per-launch P&L and a link to the launch page.
- "Share P&L Card" renders an image card (`PnlCard`, uses `html2canvas-pro`) for a day, month or year.

## Inferred

- Calendar uses only finalized launches while charts and stat cards use every non-draft launch with `launched_at`. The calendar total and the chart total for the same period can therefore differ.
- Because charts use the browser's time zone and the calendar uses the chosen time zone, the same launch can fall on different days in the two views.
- Attributing a launch's whole P&L to its launch time means realized gains later in a launch's life appear on the launch day.
- The evolution badge can show large or misleading percentages when prior history is small or of opposite sign; it does not compare equal periods.

## Unknown

- How the server computes `pnl_usd` / `pnl_native` (realized vs. marked-to-market, fee and rent treatment, price source for USD).
- `PnlCard` internals beyond the static facts retained (budget-limited semantic coverage in the whole-app run).
- Any server-side filtering of launches before they reach the client.

## Bundle today

`AccountPerformancePanel` (`components/account-performance.tsx`, `lib/account-performance.ts`) reports exact recorded results per imported project and warmup plan: linked sell-to-buy results, allocated and unallocated cost, successful fees, rent changes, unknown-basis coverage, a searchable scope table and CSV export. It has no time dimension: no timeframe, no charts, no win rate and no calendar.

## Improvements over the reference (proposed)

1. Attribute each realized result to its sale's finalized time, not the position's opening.
2. Compare a window with the preceding window of equal length, and suppress the percentage when that base is zero or of opposite sign.
3. One time-zone setting shared by every chart, stat and calendar view.
4. Exact integer (lamport) arithmetic for every bucket and total, converting only for display.
5. Show coverage with every view: unlinked sales and unknown basis are excluded and counted, never treated as zero.
6. Cumulative, per-period and win-rate views with the same timeframes, plus a calendar with streaks and per-day drill-down to the underlying finalized sales.
7. Keyboard-accessible controls and a non-chart table alternative for each chart.

## Implemented, 2026-10-12

All seven proposals are built in `lib/performance-timeline.ts`, `lib/account-performance-server.ts` (`summarizeAccountTimeline`), `GET /api/account-performance?view=timeline` and `components/performance-timeline.tsx`, shown inside the existing Recorded trading performance panel.

- Per-sale results split each lot's cost across its sales in finalized-slot order; the server refuses the response unless per-sale results sum exactly to the linked totals, and the client re-checks the same reconciliation.
- One additional improvement over the reference: All-time sizes its buckets to the recorded span (hourly up to 2 days, daily up to 180 days, monthly beyond), instead of collapsing short histories into one or two monthly points. Month labels include the full year.
- Not built: shareable P&L image card and affiliate statistics.
- Verification: 24 targeted tests (pure timeline, actual-D1 route, component render), typecheck and lint. Browser QA used a synthetic snapshot through the real component on a local dev server (desktop and 375 px); no account data, provider or database writes were involved.
