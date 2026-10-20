# Manual seller account inspection: API and console

20 October 2026. Follow-up to `825e730`. This connects the informational inspection to the Bundle seller console without creating sale, payment, delivery or signing authority.

## API and source boundaries

POST `/api/marketplace/operator/account-inspection` requires the verified session user to be a configured Bundle operator. It rejects query parameters, a different/missing Origin, non-JSON bodies, bodies above2048 bytes and extra selection fields. The request binds one owned wallet revision and positive SOL asking price, exactly as the listing draft review. There is no caller-supplied owner, provider endpoint, role or approval flag.

The existing `market_read_gates` table provides an atomic15-second limit under `marketplace-sale-inspection:<SHA256(userID)>`. Ordinary market/wallet/hold scopes are not changed. A gate write is the only service-side persistence for this operation; no listing, hold, purchase, wallet or proof is written. Missing gate schema refuses before providers. Provider429 and local cooldown both return429 with Retry-After15; there is no retry loop.

The actual owned SQL reader is supplied to the existing mainnet account collector before and after its RPC reads. Each inventory read checks the same verified session identity and current operator configuration again; access is also checked before publishing the response. A session/role change returns403. A missing selected revision or changed retained seller source returns409 through a new named source-change error; the collector's existing predicates and all other failure checks stay intact. Unknown parser/provider/storage failures return a sanitized503, cancellation408. Responses use no-store.

This still reads only the current native account, not token holdings, provenance or a fresh key-control proof. The configured ordinary RPC/pacing, genesis check, zero-byte account data slice, exact u64 amounts, before/after owned-source binding, cancellation,60-second operation limit and32-slot account-observation limit remain unchanged. No Clock or stock signing policy changes.

## Seller console

The owned `MarketplaceOperatorConsole` mounts a separate account-check panel only after a valid unpublished draft review. No inspection occurs on mount, selection, opening disclosure or review creation. The user manually requests the account check. It shows current SOL, recorded SOL, exact signed difference, provider/commitment and observation/expiry, with account metadata and slots in a disclosure. Absent accounts and unsupported owners/data/executable accounts are distinct from an ordinary SOL account.

Strict client admission checks the response envelope, all false authority flags, exact wallet/revision/price, captured historical proof/balance, integer difference, account classification/nulls, canonical timestamps,60-second expiry and ordered32-slot span. Unavailable historical balance stays unavailable. It cannot display a changed response as a successful result. The derived balance difference is not a fee, P&L or sale credit.

Editing price/wallet, reloading/expiring inventory or replacing the reviewed draft unmounts the inspection panel and aborts its request. Late responses are ignored. A new read clears the previous result first. Cancel is explicit; expiry clears the result without a refresh, and failures offer manual recovery only. Save-draft and publication approvals remain separate and unchanged; the informational result cannot satisfy either approval. The panel explicitly states the remaining sale checks and unavailable payment/key delivery.

## Verification

Final marketplace run: **416 tests across30 files pass**. This includes10 new actual route/libSQL/Turso-adapter/collector cases,19 client-admission cases,11 panel cases and a parent-console integration case. The route suite verifies exact owned SQL and provider methods, real atomic cooldown isolation/concurrency, session/operator revocation after RPC, pre-provider revision refusal, post-provider source drift, cancellation,429 without retry, admission bounds and missing gate schema. Only synthetic transport responses and disposable in-memory databases are used.

Plain `tsc --noEmit --incremental false`, scoped type-aware lint and formatting pass. React review retains direct imports, a separate owned panel, no inline component definitions, manual network work in an event, a synchronous pending lock, cleanup/expiry effects and semantic status output. The parent review boundary clears context instead of carrying consent or account evidence into another selection.

Chrome fixture QA uses the actual seller console/panel and production styles with public synthetic in-memory metadata. On desktop1440, document client/scroll widths both1440 and inspection panel widths both1122; the action is46px high. At viewport375, the document client/scroll widths both360 (the browser reserves15px for its vertical scrollbar), with panel widths both326 and the same46px action. No horizontal overflow. Seven fixture reads cover inventory/review, ordinary, unsupported, absent, rate-limit and invalid-authority inspection responses; no financial write/signature. Changing the price removes the complete inspection. Screenshots: `docs/qa/20261020/marketplace-sale-inspection/`. These fixtures do not prove real production sign-in, a live provider run or funded sale readiness. The temporary tab is closed and viewport reset.

Final isolated production build exits0 from `825e730` plus ten exact code/test overlays, with every canonical/snapshot hash unchanged. It uses a sanitized environment, no application `.env`, local font fixtures and a dependency junction. Terminal result/hashes: `CODEX-MARKETPLACE-SALE-INSPECTION-UI-BUILD-20261020.json`. Test/browser scope summary: `CODEX-MARKETPLACE-SALE-INSPECTION-UI-QA-20261020.json`. No whole-repository test pass, live sign-in/provider or funded proof is claimed.

## Coordination and remaining work

Owned paths only: account-inspection route/tests, inspection view/tests, the collector's named source-change error, the new panel/tests, seller-console mount/test and public fixture helper. Protected shell/token layout, Claude's other components, migrations and database schema remain unchanged. Next migration remains0122 subject to recheck. No application/hosted SQL, real provider calls, real operator access configuration, credentials/provider/cron changes, actual publication/hold/payment, wallet unlock/sign/send, funded action or deployment.

Remaining marketplace work: fresh current control and token/authority checks, provenance requirements, exact buyer checkout approval, durable payment-in-progress protection beyond the five-minute hold, finalized one-payment reconciliation, secure delivery/import and actual purchase recovery/history. Broader Proxima parity remains incomplete. This account snapshot is useful evidence, not sale qualification.
