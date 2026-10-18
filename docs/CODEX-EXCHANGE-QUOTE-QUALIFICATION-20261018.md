# Single-quote exchange provider qualification

18 October 2026. The next live funding prerequisite is current native SOL private-transfer quote access. Bundle's ignored.env.local contains no CHANGENOW_API_KEY or BUNDLE_EXCHANGE_QUOTES_ENABLED assignment. Only presence booleans were reported; no secret value was displayed, copied or changed. The user was asked for an existing secret-file path or setup instructions. No answer/key is assumed.

New scripts/qualify-exchange-provider.mjs requests at most one exact GET to the pinned private-transfer quote path. It refuses every other method/origin/path/query/body, and never retries. It executes the actual quote service, prepares an immutable quote/refund review and reloads both through the actual guards in a disposable in-memory SQL fixture. All ownership evidence is explicitly synthetic; no real user wallet is read. No approval, provider order, deposit, signature or broadcast path is imported/executed. It never uses a hosted database.

A new work folder retains a sanitized receipt for configuration, build, provider, validation and successful outcomes. Build runs only after configuration validation. The receipt keeps stage/refusal codes, separate HTTP/service status, request counts, bounded quote amounts, source hashes, executed bundle hash, named-source stability and local reload results. It excludes keys, full provider URLs, rate references, raw errors/notices, wallet addresses and response bodies. The complete fetch/body has a15second boundary with a64KiBbody limit and redirect refusal. The flag liveQuoteQualified is false for injected synthetic responses and does not claim order/status/deposit support. Source stability covers the named vector, not every installed dependency or all app source.

## Running after a key is supplied

From the canonical Bundle folder, using the pinned Node24executable and an already authorized local environment file containing the key:

```powershell
& 'C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --env-file=.env.local scripts/qualify-exchange-provider.mjs --live-readonly --payout-sol=1
```

The1SOLargument is a desired quote payout, not money spent or sent. No production enable flag needs to change. The CLI accepts no order/deposit/send mode. This command is documentation for the pending keyed check; it was not successfully qualified against a live provider in this checkpoint.

## Verification and actual outcome

Six native cases pass, including missing key/runtime/intent/amount startup receipts, one synthetic quote with actual SQL review/reload, first429with no retry, wrong network, malformed/oversized body and redirect refusal, and exceptions carrying fake credentials that must not enter reports. Synthetic transport is labelled in every test receipt. The100existing quote/order Vitest cases in two files also pass. Both new.mjsfiles pass formatting, lint and syntax checks. No application source changed, so no new full-suite, TypeScript, browser or production-build claim is made.

The actual local startup check returned a non-success configuration receipt with providerRequests:0 and provider-key-missing-or-invalid. It is retained under work/exchange-provider-qualification-2026-10-18T20-06-58-776Z-9b4d8f0b-b218-471d-bc15-d71c3b7e38db/receipt.json. That initial receipt predates the final clarity rename of the live-result field; it remains refused and is not live evidence. Final current-source native log: work/release-qa/exchange-provider-qualification-native-20261018.log. Related model report: work/release-qa/exchange-qualification-20261018.json. Artifacts are ignored local evidence; source and this report are on Git.

Current live quote access remains unverified. Nothing was copied from Smoke's credentials, no provider or environment setting changed, and no external provider request, live order, hosted SQL, wallet action or deployment occurred. Other Bundle chat's account-purchase UI/API/tests and ownership notes were preserved. The broader Proxima funding/execution, marketplace fulfillment, stock qualification, full holder coverage and audited P&L goals remain incomplete.
