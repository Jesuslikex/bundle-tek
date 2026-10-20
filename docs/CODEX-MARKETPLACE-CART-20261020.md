# Bundle-only marketplace: multi-wallet cart review

20 October 2026. Source checkpoint follows `4316001`. This is a buyer selection and read-only review step, not a completed marketplace or checkout.

## Behavior

- Choose individual listings or replace the selection with up to 200 matching wallets in the displayed order. The default requested count is 25; shortages and the 200-wallet cap are explained.
- Filtering and pagination retain selected wallets. A visible message counts selections hidden by the filters. Removing or replacing selections invalidates any previous review.
- A manual review sends only canonical listing IDs and SHA-256 fingerprints of their complete public entries. The server freshly reads the first-party publication catalog and refuses missing, withdrawn, archived, operator-revoked or changed entries.
- Exact bigint asking-price totals are shown in SOL. Historical balances never reduce this price. Network fees remain unquoted, not zero. Aggregate amounts above u64 refuse review.
- Reviews expire with the server catalog snapshot after 60 seconds. Expiry clears the checked result but retains selected IDs as an unverified draft. Manual refresh retains available IDs, removes unavailable IDs with an explanation, and does not automatically request another review.
- A changed snapshot, selection or expiry state gets a fresh keyed review component. Unmount cleanup aborts the old request; late replies cannot populate the new review. Filter changes alone retain it. Explicit cancellation, sign-in recovery, sanitized HTML/error handling and no automatic retry are preserved.

## Authority and trust

The route performs SELECTs only. Browsing and review never reserve inventory. `reserved`, `purchaseEnabled`, `paymentEnabled`, `deliveryEnabled` and `signingAllowed` are all literal false. The review is not a checkout token or financial approval. No private key, signed packet, RPC call or real operator configuration is introduced.

Bundle is the only seller. Existing public custody disclosures remain unchanged: retained control evidence does not prove every copy of a private key was deleted or that a buyer will have exclusive control. Recorded activity age is distinct from creation or funding age. No guaranteed airdrop eligibility is inferred.

## Verification

- 21 marketplace test files, 287 tests pass. New coverage includes 18 cart-domain cases, eight route cases and 12 client cases.
- Route tests use actual in-memory libSQL through the production Turso adapter, the real publication/draft migrations and storage services, a mocked verified session and test-only operator IDs. Query capture proves SELECT-only cart handling; outbound fetch refuses. No hosted or application database is migrated.
- Client tests use a controlled clock, actual digest bytes and declared transport fixtures. They cover cancellation, altered authority/price/HTML, expired review retention, changed same-ID snapshots, hidden selections, withdrawal reconciliation and the 200-wallet cap.
- Scoped type-aware lint and formatting pass. Plain `tsc --noEmit --incremental false` passes. Final isolated `next build --webpack` exits 0: baseline `4316001` plus the eight owned source/test overlays, dependency junction, sanitized environment, no real `.env`, and local font fixtures. All eight canonical and snapshot hashes are unchanged after the build. Evidence: `CODEX-MARKETPLACE-CART-BUILD-20261020.json`. The first build was intentionally stopped after lint identified the effect-state reset issue; it is not counted as a pass. The final keyed-component correction and regression test are included in the passing build.
- Chrome renders the actual catalog/cart components and CSS against explicitly labelled synthetic public fixtures. Desktop widths 1920 and 1440, and phone width 375, have matching document client/scroll widths. Phone review/clear controls measure 46 px tall.
- Browser observations: three fixtures total exactly 0.075000002 SOL; filtering below 0.03 retains all three with one hidden. Withdrawing the 0.05-SOL fixture causes a 409 review refusal; manual refresh removes one and retains two totaling 0.025000002 SOL. Forged reservation, HTML error and signed-out responses show safe errors with no financial controls. Fixture writes remain zero.
- Natural browser expiry also clears the checked result, retains three selected IDs, disables new review and leaves fixture request counts unchanged. Final screenshots after the React state-reset correction: `docs/qa/20261020/marketplace-cart/desktop-review.jpg`, `phone-review.jpg` and `phone-expired.jpg`. Browser fixture transport is not evidence of production sign-in, live inventory, payment, delivery or durable writes.

## Remaining work and release boundary

Qualified funding/source/region/tier filters, fresh sale eligibility, reservations, exact buyer consent, payment, secure delivery and order recovery remain open. This checkpoint makes no broad Proxima parity or completed sale claim. No deployment, application/hosted SQL, actual listing publication, provider/credential/cron change, wallet unlock, signing or funded action. No migration is added; the journal remains at 0119 and the next number is 0120, subject to recheck.
