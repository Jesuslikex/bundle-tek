# Marketplace buyer hold approval and recovery

20 October 2026. UI step after authenticated reservation API `15c04f6`. This does not complete checkout or broad Proxima parity.

## Buyer workflow

The real `/marketplace` workspace wraps its first-party catalog with the owned buyer dialog. A successfully checked cart exposes Review wallet hold. Opening the dialog makes no request. The dialog shows exact SOL asking prices, count, network/seller, unquoted fees, the original review expiry and selected public addresses. A separate unchecked acknowledgement covers the five-minute hold, no payment/purchase/signing/delivery, Bundle-only sales and the retained-key limitation. Only an explicit click can request a hold.

The client replays the cart before writing, creates one UUID, retains only that ID in this tab's session storage before the POST, and admits the exact saved response against the original request. A pending operation has one AbortController and one write attempt. Timeout, cancellation, unmount, malformed/HTML response or unverifiable result never automatically retries and leaves the same ID for manual GET recovery. Closing or Escape stops waiting, not a server-side hold. Read-only recovery does not renew a lease or approve a new operation.

Recover wallet hold is available without a new cart selection. It accepts a copied ID or the ID retained in this tab. The field remains selectable/read-only for an existing ID. Opening recovery makes no request. The server still enforces buyer ownership, including after sign-in changes. A sign-in failure or unknown result cannot silently discard the recovery handle or start another hold. A 404 explains the account check before explicit local-ID cleanup. Browser storage failure leaves a visible warning to copy the displayed ID.

Verified held/released/expired status, count, exact price, expiry and saved public details remain distinct from financial readiness. A release requires a new unchecked acknowledgement and one explicit POST. Unknown release results require manual recovery before another write. Local expiry removes release approval without polling. Only a recovered release, expired receipt or explicit not-found result permits clearing the local ID; immutable server history is retained.

Every hold/release POST attempt invalidates the catalog's captured availability version, including an unknown outcome. The old unreserved review disappears and selection/review is disabled until an explicit inventory refresh. Selected IDs remain an unverified draft. A catalog read that started before a concurrent hold cannot mark the newer version fresh. This is client consistency, not a substitute for server/SQL availability guards.

The existing accessible Base UI dialog supplies focus management and keyboard dismissal. Focus returns to the stable recovery toolbar button even after a hold invalidates and removes the original review button. Owned CSS keeps content within the viewport, scrolls vertically when necessary and preserves 44 px actions. No shared dialog, global CSS or protected shell/token layout is changed.

## Evidence and scope

The prior backend tests use actual SQLite/services; browser QA here uses the actual buyer/catalog/cart components with explicitly labelled public in-memory fixtures. It is not proof of production authentication, durable browser-backend persistence or sale readiness. Fixture writes only create/release memory records. No real API, account database, provider, payment, wallet key or signature is used.

All 25 marketplace test files pass together: 327 tests, including 12 buyer cases. They use the actual dialog, domain admission and controlled clock/transport fixtures, including same-ID remount recovery, altered result/authority rejection, pre-write review expiry, local hold expiry without polling, cancellation/late reply, lost release, sign-out and known/unknown background-availability invalidation. Actual native API/storage coverage remains in the preceding checkpoints. Plain TypeScript, typed lint and formatting pass.

The browser exercised a two-wallet 0.075000001 SOL cart, unchecked hold/release approvals, Escape focus return, committed-response loss, manual same-ID recovery with exactly one memory write, explicit release and manual inventory refresh. No automatic request was made on dialog/recovery open. Final invalidation scope checks show three requests/one memory write after the unknown reserve, four requests/one write after recovery, then six requests/two writes after release and explicit inventory refresh. The prior unreserved review disappears before recovery. This remains synthetic memory evidence, not durable production behavior.

At 1440px desktop and 375px phone, the dialog stays within the viewport. The phone popup measures 343px wide; its client and scroll widths match. Approval height is about735px and a longer held view is capped at780px with vertical scrolling. Dialog actions measure44px. Resizing produced a transient mid-transition screenshot; final images were taken after layout settled. The ID is read-only and enabled for copying. Final captures: `docs/qa/20261020/marketplace-reservation-buyer/desktop-approval.jpg`, `desktop-held.jpg`, `phone-approval.jpg` and `phone-held.jpg`.

The first isolated source build passed before the background consistency gap was corrected. Final `next build --webpack` exits0 with that correction and eight owned source/test overlays on `15c04f6`, all canonical/snapshot hashes unchanged. It uses a sanitized environment, no application `.env`, local font fixtures and a dependency junction. Evidence: `CODEX-MARKETPLACE-RESERVATION-BUYER-BUILD-20261020.json`; detailed final tests remain in ignored `work/release-qa/marketplace-reservation-buyer-final-tests-20261020.json`. No whole-repository test-suite, production sign-in, funded proof or full parity is claimed.

## Still open

Server-side saved-hold discovery across closed tabs/devices, fresh sale qualification, payment destination and approved signing, finalized payment reconciliation, secure delivery/import and purchase history remain unfinished. Session storage is a convenience, not a server history index. Do not call a hold a purchase or treat its hash as financial approval.

No migration or journal edit, application/hosted SQL, actual listing/hold, real operator configuration, provider/credential/cron change, wallet unlock/sign/send, funded action or deployment. Migration 0120 remains a release prerequisite; next number stays 0121 subject to recheck.
