# Saved supply distribution

Codex added `components/supply-distribution-summary.tsx`, its CSS module and focused rendering tests, plus `lib/supply-distribution.ts`. The summary replaces the plain totals grid in `components/saved-supply-monitor.tsx`. Claude's watch-wallet parent, holder view, helper and tests were not edited.

The graphic uses the existing validated saved observation. Watched team, external, pool and unobserved balances are disjoint. Cumulative BigInt ratios preserve the full bar without rounding gaps; external wallets sort by exact raw balances, including amounts above safe Number precision. The expandable ranking is explicitly scoped to the watchlist, not advertised as complete holders or global Top 10.

Validation: 18 focused tests passed across distribution, saved monitor, supply history and monitoring retry files. TypeScript and scoped oxlint passed. Production build passed with bundle-size and runtime deprecation warnings. An isolated rendering fixture using the actual component and CSS was checked at desktop and 390px phone widths; phone document width equalled viewport width with no horizontal overflow. This fixture is not a live account or provider verification.

Preview artifacts are in the Codex chat's `outputs/supply-distribution-preview.html` and `outputs/supply-distribution-desktop.jpg`. The temporary rendering test and loopback preview server were cleaned up. No signing, provider requests, application deployment or Claude-owned source edits were part of this change.

Remaining parity work includes complete holder indexing with explicit coverage, decoded trade classification, live account workflow QA, and separately authorized funded transaction verification.
