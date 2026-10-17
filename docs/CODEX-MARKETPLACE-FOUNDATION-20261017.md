# Wallet marketplace foundation

17 October 2026. Source baseline: main e1886ed. This is a local catalog foundation, not a completed purchasing marketplace.

## Reference and scope

The retained REA evidence in CODEX-PROXIMA-MARKETPLACE-REFERENCE.md describes wallet inventory, age/source/history filters, separate balance/price/net totals and quote/settlement/delivery recovery controls. It does not establish a strategy marketplace, supplier contract or successful wallet purchase. No new Proxima runtime inspection was performed for this change.

New standalone /marketplace and authenticated GET /api/marketplace/catalog support a strict server-owned catalog adapter. No supplier is connected and no real inventory is fabricated. The initial screen asks the user to refresh; without configuration, the authenticated API returns 503 explaining that no provider is connected. Visitors without a session get 401. Catalog fields may be used only as provider assertions, never independent provenance.

The screen supports 25/50/100/200 entries, minimum funding age, minimum gap between selected funding timestamps, source, tier, minimum balance and maximum price. Amount filters use lamports. Exact BigInt sums separate balance, purchase price and price less balance, including negative differences. Selection is deterministic cheapest-first, with gap exclusions; it is not an optimal portfolio solver or a promise to fill the selected count. Coverage and matching/selected counts are separate. Inventory expires after 60 seconds. Editing filters cancels pending reads and clears old results.

## Provider contract, intentionally not configured

MARKETPLACE_CATALOG_URL is a server-only HTTPS gateway endpoint with no embedded credentials, query, fragment or custom port. MARKETPLACE_CATALOG_TOKEN is an optional server-only Bearer token. Do not point this at an arbitrary Proxima endpoint: this is Bundle's own explicit wire contract, and a real supplier needs a reviewed adapter/agreement before configuration. No credentials or provider settings were changed.

The gateway returns exactly:

- format: bundle-wallet-catalog-v1
- chain: Solana
- provider: display label
- observedAt: UTC ISO timestamp, at most 60 seconds old and not in the future
- coverage: complete or partial, as asserted by the provider
- listings: at most 500 public records, each with id, address, source, tier, fundedAt, balanceLamports, purchasePriceLamports and transactionCount

Tier values: funding-only, light-history, established. Addresses must decode canonically to 32 bytes; identities and addresses cannot repeat. Raw per-wallet monetary values are unsigned 64-bit integer strings. Unknown fields, including key material, are rejected. Secret-bearing bodies and provider error details are never forwarded. Fetches have an eight-second timeout, a 256 KiB streamed UTF-8 body cap, no redirects, no retries and no caching. IP literals and local/non-public host labels are refused; the operator must choose a reviewed public gateway and restrict its network egress. This validation is not a DNS-rebinding firewall. No live supplier compatibility or load/rate-limit contract is claimed.

## Ownership and remaining work

New page, panel, CSS module, API and lib files only. Claude's app/page.tsx, token layouts and wallet UI remain untouched. The standalone route can be opened directly. Sidebar wiring is left to the shell owner; no ownership approval is requested for the new standalone files.

Not implemented: supplier onboarding, independent provenance/balance verification, inventory pagination/reservations, price quotes, checkout/payment, acquisition approval, encrypted delivery into the browser vault, immutable orders/history and purchase recovery. There is deliberately no purchase, import, funding or signing action in this slice. Wallet custody, stock signing, provider configuration, migrations, cron and production deployment are unchanged.

## Verification

- Node 24.19.0: four marketplace test files, 22 tests passing together. Coverage includes authentication failure/null session, invalid/repeated filters, partial coverage, spacing, exact integer totals, duplicate identities, unknown/private-key fields, future/stale inventory, upstream HTML/429/errors, response byte limits, cancellation, UI expiry and refusal of purchase-authority responses.
- TypeScript, scoped typed oxlint and oxfmt checks pass. Final production build passes under Node 24, including /marketplace and /api/marketplace/catalog.
- Existing Chrome profile: final built page inspected at the normal desktop viewport and 375 x 812. Phone document width 375, content width 360; no page-wide horizontal overflow. Screenshots are ignored local artifacts in work/marketplace-qa/desktop.png and mobile.png. Real supplier rows were not browser-tested; populated catalog tests use explicitly synthetic fixtures.
- The local production server's existing auth guard requires a secure origin, so local HTTP cannot establish a real signed-in session. The new API handles that as 503 AUTH_UNAVAILABLE without leaking details, and the rendered page shows the distinct sign-in-unavailable message. This is not evidence of a production sign-in defect or an authenticated live supplier pass. The ordinary null-session 401 and unconfigured-provider 503 paths are verified in tests.
- No full-suite, live inventory, signed-in production, purchase or delivery claim. No remote action or provider/credential setting changed.

During verification origin/main advanced from e1886ed to 066d47f with unrelated Claude work. No overlapping marketplace paths were present. The tested change is retained on codex/wallet-marketplace-catalog for review; integrating and verifying the latest combined main remains separate. Only the new owned files are committed, with no shell/layout patch or deployment.
