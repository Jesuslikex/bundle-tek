# Claude UI update: function check fixes

13 October 2026. Claude clicked through every sidebar page, the launch flow and the token workspace in a local preview (local test user, scratch D1, no provider keys), and fixed the defects found. No server, migration, DCA or Counter code changed.

## Fixes

- **Launch draft name and ticker** (`components/launch/token-details-form.tsx`): new drafts prefill "Untitled Plan" and "TOKEN" as real values, so typing appended to them ("Untitled PlanMy Token", "TOKENUITT"). The default text is now selected on focus, so typing replaces it. User-entered values are unaffected. `lib/launch-plan.ts` defaults are unchanged.
- **Duplicate React keys** (`components/wallet-tracker.tsx`): the transaction history and holdings panels used the same key when both were open for one wallet, so React could drop or duplicate a panel. Keys are now prefixed `history:` and `holdings:`.
- **Duplicate React keys** (`components/account-performance.tsx`): the timeline and summary shared the `observedAt` key. Keys are now prefixed.
- **Account costs errors** (`components/account-costs.tsx`): signed-out users now see "Sign in to view account transaction costs." instead of a generic failure, and an HTML error page no longer surfaces parser text.
- **Empty performance state** (`components/account-performance.tsx`): with no recorded trades, the panel shows one message instead of an empty chart, calendar and table.
- **Table captions** (`app/ux.css`, appended): `.project-table` captions are small, left-aligned labels instead of centered body-size text.

## Checked and working

Dashboard (performance, costs, filters), My wallets, Supply tracker, Wallet tracker (add, inspect, history, holdings), Activity, Archived, Funding review, Devnet distribution, Operations preview, Pulse simulation, Create launch (all three steps, Save plan) and the token workspace. Quote and holder reads report missing provider configuration in this keyless preview, which is expected.

## Not changed, noted for Codex

These components also parse `response.json()` before checking for a non-JSON error page, which can surface raw parser text: `imported-lot-links.tsx`, `imported-sell-acquisitions.tsx`, `session-entry-outcomes.tsx`, `token-operation-history.tsx`. `browser-wallet-vault.tsx` has the same pattern but was left alone because it is wallet-security code.

## Verification

New tests: `components/account-panels.test.tsx` (3) and `components/launch/token-details-form.test.tsx` (2). 37 related test files (179 tests), actual-source TypeScript and scoped lint pass. Nothing pushed or deployed.
