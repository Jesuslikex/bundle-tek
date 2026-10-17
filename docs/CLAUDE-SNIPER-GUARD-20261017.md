# Sniper Guard (17 October 2026)

Proxima reference: https://docs.proxima.tools/create-launch/funding/sniper-guard/

## What Proxima does

A threshold in the launch currency. External buys are summed; the guard triggers only when the total is strictly greater than the threshold. Responses: Nuke (All / Holders Only / Dev Only, Dev Only with an optional Complete Early) or Complete Early (stop remaining holder buys, sell nothing). End conditions: Until Complete or Timed (minimum 1 second). Optional whitelist excluded from the total. Proxima executes the response server-side.

## What Bundle does

- `lib/sniper-guard.ts`: strict settings, exact raw threshold conversion, pure evaluation (strictly greater than, slot order, signature de-duplication) and the Proxima response mapping.
- `lib/sniper-guard-chain.ts`: read-only measurement. For every successful transaction on the bonding curve it measures quote paid into the curve (curve lamports for SOL, the curve quote token account for USDC/stock). A buy is ignored when any signer is a launch wallet, any wallet with a Bundle ownership proof, or a whitelisted address. Bounded pages (5 x 100 signatures per poll); overflow marks coverage partial so the total is a minimum. Allowed RPC methods: `getSignaturesForAddress`, `getTransaction`, `getMultipleAccounts`.
- `drizzle/0095_sniper_guards.sql`: one guard per owned group review. Triggers enforce revision +1, settings frozen after arming, legal transitions only (planned -> watching/stopped, watching -> triggered/ended/stopped), terminal states immutable, no deletes.
- `app/api/launch/pump/sniper-guard`: GET context; POST save / arm / observe / stop. Same-origin, exact request keys, 1-1.5 s per-guard gate, read-only RPC transport.
- `components/launch/sniper-guard-panel.tsx`: mounted in the complete-group review. Polls every 2 s while watching. On trigger it shows an alert, a browser notification (if allowed), the Nuke wallets with token balances and a button to open the token workspace where each sell is reviewed and signed.

## Differences from Proxima (by design)

- No automatic sells. A trigger prepares the list; the user signs every sell.
- Watching runs only while the tab is open (browser poll, no server worker holding keys).
- Complete Early is advisory with today's single atomic group bundle, which has no remaining holder buys once it lands. It becomes meaningful with staged (Organic/Stagger) launch modes.
- Until Complete ends when the group review reaches a terminal state (finalized/failed/cancelled).
- Quote measured is what entered the curve, which can include curve-side fees; Proxima does not document its exact measure.

## Verification

Offline only: 37 new tests (settings, evaluation, chain decoding, storage triggers, route, panel), migration chain test and the real Wrangler whole-file migration check (93 files) pass; TypeScript and scoped oxlint pass. No live RPC read, funded launch, deploy or signing.

Migration numbering: 0092 PR #2, 0093 launch modes, 0094 token tools, 0095 Cleanup. This file is 0096; the journal `idx` must be renumbered to its final position when merged after those.
