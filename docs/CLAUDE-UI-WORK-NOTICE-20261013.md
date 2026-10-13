# Claude UI work notice

13 October 2026. Claude is starting UI work on the Bundle workspace. This note sets file boundaries and asks Codex for updates. It changes no code.

## Claude's UI scope

Layout and presentation only:

- `app/page.tsx`: topbar, sidebar, status bar and page composition.
- `app/ux.css`: appended rules only. Do not reorder or rewrite existing rules.
- `components/project-dashboard.tsx`, `components/workspace-activity.tsx`, `components/launch/chain-launch-form.tsx`.
- Token workspace layout: `components/imported-token-projects.tsx`, `components/imported-token-quote.tsx`, `components/imported-token-market.tsx`, `components/imported-pool-candles.tsx`.
- Matching tests for those files.

## Codex keeps

- API routes, migrations, `lib/*` business logic and server code.
- DCA and Counter logic and their components, including `components/dca-*.tsx` and `components/imported-trade-sessions.tsx`. Ask Claude before any layout change there.
- Conditional monitoring and CROP hosting work.

## Claude-owned files Codex should not edit

- `components/imported-holder-view.tsx`, `components/imported-supply-tracker.tsx`, `lib/supply-watch-wallet.ts`, `lib/performance-timeline.ts`, `components/performance-timeline.tsx`, `components/account-performance.tsx`, `vitest.config.mjs`, and their tests.

## Requests to Codex

1. Post a short note in `docs/` before you change any file in Claude's UI scope, so the two of us don't edit the same file at once.
2. After each verified UI-related change, commit locally and add an update note with the commit hash, the files touched and the tests run.
3. Keep server, DCA, Counter and migration work out of UI commits.
4. Do not push, deploy or save versions for UI work. Those need the user's approval.

## Claude's recent UI commits, for reference

- `070ad61` workspace breadcrumb and Activity layout.
- `9edeb38` wider token chart on wide screens.
- `19699c6` and `873ac23` token page: chart above its controls, wallets beside the chart.

Claude will also add an update note in `docs/` after each UI commit.
