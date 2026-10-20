# Bundle-only marketplace seller review

20 October 2026. Baseline `bb4f22a`. Julian chose Bundle-operated inventory only, with no third-party sellers. This checkpoint adds server-enforced seller access and an exact unsigned listing review. It does not make wallet sales available.

## Access and evidence

`MARKETPLACE_OPERATOR_USER_IDS` is a server-only explicit JSON array of verified authenticated user IDs, not email addresses, browser claims or a wildcard. Missing, malformed, duplicate, oversized or empty configuration denies access. No real account IDs or configuration were added. Configuration must be performed as a separately authorized access change. Both operator routes authenticate and authorize before inventory SQL; ordinary accounts cannot assign themselves access through this UI.

GET `/api/marketplace/operator/inventory` accepts no query selectors and reuses the existing owned-wallet evidence reader. POST `/api/marketplace/operator/listing-review` requires same origin, JSON and a streamed 2 KiB maximum. It accepts only a public wallet address, current revision and positive canonical integer lamport asking price within u64. Ownership and active revision come from the server snapshot. Cancellation and storage errors return sanitized responses with no caching. Neither route writes to storage, calls providers, reads vault keys or publishes a listing.

The review binds the exact selection and captured public evidence with SHA-256 digests. Derived age advances to review time; historical proof and observation timestamps are never refreshed by a review. The client reconstructs the expected review from its snapshot and refuses changed evidence, price, revision, disclosure, expiry or authority flags. All four flags are literal false: listingAllowed, paymentAllowed, deliveryAllowed and signingAllowed. A hash is a content binding, not a publication authorization or proof of key erasure.

The disclosure says Bundle is the only seller, historical control does not prove exclusive custody and the seller may retain a key copy. Sampled activity does not establish creation, first funding or organic trading. Existing balances are historical, not a purchase entitlement or live guarantee.

## Seller console

The owned marketplace workspace now has a separate Seller console. It performs no fetch on entry, exposes no role-assignment controls, and explains sign-in or denied access. An authorized operator can select an owned public wallet and enter a SOL asking price. Positive values with at most nine decimals are converted exactly to lamports. The resulting unpublished review shows wallet/revision, price, historical control and activity dates, custody disclosure, expiry and hashes. There are no Publish, Buy, Approve or Sign controls.

Edits clear the old review and abort pending work. Late replies are discarded. Inventory and reviews expire locally without retry. Switching sections unmounts the console and cancels its pending request. HTML/parser failures display safe text. Protected shell and token layout files are untouched.

## Verification

All eleven marketplace test files pass together: 154 tests, including the existing buyer catalog/provider/UI, actual disposable local-D1 owned-inventory route, policy, review, operator routes and seven new UI cases. Operator-route tests use the real shared evidence model with a mocked read-only SQL adapter and verified-auth fixture; they do not establish a live configured operator. UI tests compute real SHA-256 bytes through a deterministic async adapter rather than depending on worker-pool completion timing. Domain/route tests retain the native digest path.

Plain TypeScript and scoped typed lint/format pass. Browser checks use real components/CSS/model with explicitly synthetic local responses, not production accounts or newly configured roles. They verified zero requests on entry, buyer denial, operator fixture load, exact 0.05 SOL review, disclosure, edit invalidation, malformed authority refusal, natural expiry without a request and sanitized HTML failure. Desktop viewport was 1523px with main widths 1523/1523; at 375x812 the document was 375/375 and main 360/360. Operator form/button heights were 44/46px. Public fixture screenshots are in `docs/qa/20261020/marketplace-operator/`. The QA tab/server were closed and viewport restored.

The isolated production build on `bb4f22a` plus ten owned overlays exited 0 with `unchanged: true` and `passed: true`. Existing nested-workspace and no-cache warnings remain. No application source changed during the build. Local artifacts: `work/release-qa/marketplace-operator-tests-20261020.json`, `work/release-qa/marketplace-operator-build-20261020/` and `work/marketplace-operator-browser-20261020/`.

## Still unfinished

No actual operator access is configured. Persistent listing drafts/publication, fresh provenance qualification, sale reservation, buyer acknowledgement, payment reconciliation, exclusive delivery, recovery and fulfillment are still absent. The existing buyer catalog remains a disconnected preview, not live Bundle inventory. Only the seller review is implemented here. No full-repository suite, production signed-in QA, funded transaction or full Proxima parity is claimed.

No schema/migration, application or hosted SQL, provider/credential/cron setting, real wallet unlock/sign/send, payment or deployment change. Journal remains at 0117. Git publication does not activate production.
