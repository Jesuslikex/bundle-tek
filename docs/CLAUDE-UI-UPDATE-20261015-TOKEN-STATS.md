# Claude UI update: token stats strip

15 October 2026. Claude-owned token workspace layout, per `CLAUDE-UI-SPLIT-AND-LAUNCH-FIXES-20261015.md`. No server, migration, launch, DCA or Counter code changed.

- New `components/token-stats-strip.tsx`: Proxima-style headline row at the top of the market pane with price, market cap, liquidity, 24h volume and 24h change (green/red), plus pair and read age ("read 3m ago"). Readings older than five minutes are marked stale in amber. The read age updates every 30 seconds.
- New `lib/token-stats-format.ts`: display formatters. Tiny prices collapse leading zeros into a subscript count ("$0.0₄4567"); the exact provider price stays in the tooltip and in the market details. Compact dollars ("$4.06K"), signed percentages and read age.
- `components/imported-token-market.tsx`: mounts the strip when a saved observation and selected pair exist. The old four-cell strip inside the collapsed "Market observations and conditions" section is replaced by one sentence with the exact price, market cap and liquidity, so the numbers are not shown twice.
- `app/ux.css`: appended `.token-stats-strip` rules. Five columns on desktop, two columns when the market pane is narrower than 560px.

Verification: 5 new tests (formatters and strip), 88 related test files (470 tests), TypeScript and scoped lint pass. Rendered with production CSS at 1440px and 375px: one row on desktop, two columns on phone, no horizontal overflow. Signed-in rendering inside the live token page was not checked locally because the worktree has no auth or database settings. Nothing pushed or deployed.
