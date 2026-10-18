# Internal exchange provider transport contract

18 October 2026. New internal factory createExchangeOrderTransport is disabled unless its caller explicitly supplies enabled:true and a server key. There is no application consumer and no environment-based enablement. No current route imports it, and no provider/credential setting was read or changed for this work.

## Contract evidence

Read Smoke/server/changenow.mjs and Smoke/docs/exchange-transfers.md without modifying Smoke. The historical Smoke note reports a real unfunded order/status check on7September, not current Bundle access or funded proof. Fresh public source: [official ChangeNOW API documentation](https://documenter.getpostman.com/view/8180765/SVfTPnM8?version=latest), read in Chrome under APIv2/PrivateTransfers and Transaction status. Selected status section: [v2 status lookup](https://documenter.getpostman.com/view/8180765/SVfTPnM8?version=latest#e7383038-3f62-41c4-a965-9f23f98c2fd1).

The documented private-transfer request carries currency/network, desired payout, receiving address, optional refund information and rate reference. Creation returns provider identity and deposit/payout attributes; status uses an existing identity. Documentation describes varying response fields and shows differing numeric representations. This supports a strict adapter shape, not proof that a particular key currently supports native SOL private transfers. The response example can omit refund details; Bundle does not invent their confirmation. No create/status call was sent to ChangeNOW.

## Implementation

Pinned HTTPS origin and exact private-transfer POST/status GET paths; no caller-provided URL. The server key appears only in its header. Native SOL inputs, exact positive decimal payout, separate canonical receiving/refund wallets and bounded rate/reference fields are checked before HTTP. No network/token fallback, redirects, cookies, caching or automatic retries.

Response bytes are bounded at64KiB and the entire fetch/body operation at15seconds. Cancellation settles ignored transports/readers; timeout and private HTTP/error bodies produce static refusal messages. For known amount fields, numeric JSON tokens use the original reviver source spelling before floating-point rounding. Canonical decimal tokens with at most9fractional places are preserved as strings; exponent, negative or finer-precision numeric values refuse. String amounts remain subject to the unchanged existing model validation. The required source-context capability is exercised under the pinned Node24runtime.

No order/receipt/service predicates changed. Existing immutable order service retains references before matching and retains ambiguous attempt holds. Transport acceptance is not approval, funding readiness or payout settlement. Provider finished reports still require independently finalized receipts, and receipts still do not establish current spendability. A missing refund echo stays unresolved even when an identity was returned.

## Verification and release boundary

Final16exchange files/287tests pass with pinned Node24, offline envDir:false and two workers. New16transport cases plus5synthetic HTTP/service/local-SQL cases cover gate/URL/header/input boundaries, lossless decimals, malformed/oversized responses, first429/redirect refusal, ignored cancellation/body deadlines, exact native order/status matching, one retained attempt, no repeat creation, ambiguous response holds, reference retention before amount refusal, changed deposit-address refusal and missing refund echo. All existing quote/review/history/payout checks pass in the same run. Final report/log: work/release-qa/exchange-transport-20261018.json/.log; this is the current combined exchange report rather than the earlier reused per-checkpoint filenames.

Three new TypeScript files pass formatting/type-aware lint; whole-project TypeScript passed before the other chat's later account-purchases drafts advanced. Initial lint flagged intentional control-character regex spelling and a test-only URL stringification; both were corrected and lint rerun without disabling rules. No UI, schema/migration, route, environment/provider, credential, signing rule, hosted SQL or deployment changed. No full-suite, production build, live provider or funded qualification is claimed.

Next: operator setup and explicit live read-only qualification, then the separately consented/gated order API and UI. Until that integration exists, the refund-review panel correctly leaves provider order creation and deposits unavailable. Other Bundle chat's account/purchase drafts are preserved; its0114migration is committed separately in a77decf, so the next migration must be rechecked rather than assuming0114is free.
