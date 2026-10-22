# Fixed public warmup asset qualification

22 October 2026. Source base `0db62c776ae360fc1cde3810068c2fab47e1b31a` with the qualifier-only overlay committed alongside this note.

## Scope

The standalone Node24 qualifier calls the existing warmup asset collector through a fixed read-only transport: mainnet genesis, confirmed slot, then two reads of WSOL, USDC, Clock and Rent. It permits at most four requests in that order through one existing private HTTPS configuration. No retry, public fallback, wallet-account query, quote, simulation, signature, transaction or strategy mode exists. Existing local indexer configuration is selected before the existing mainnet setting; invalid selected settings refuse rather than switching endpoints. No setting or credential is changed on disk or Vercel.

The keyless fixture applies all 139 unchanged migrations to an in-memory database and retains a real source review through the existing service. Its public wallet identity is never requested from the provider. This is a disposable source fixture, not a signed-in user's wallet or an application/hosted database.

The builder captures exact compiler-consumed source bytes, freezes tsconfig bytes and copies the original migration journal/SQL into the ignored probe directory. The fixture runs from that frozen schema. Source, copied schema and bundle hashes are checked before the provider read and afterward. External installed packages are not a separately reproducible dependency image; the package manifest and lockfile hashes identify their intended versions.

The transport bounds buffering to 512 KiB, rejects redirects and unexpected account lists/parameters, latches after malformed requests, HTTP/RPC errors or transport/body failures, and retains only fixed metadata and public numeric Clock diagnostics in its trace. Successful bytes reach the original integer-preserving parser unchanged. The full evidence stays in ignored `work/` and includes the provider hostname, so it is not a public upload. It has no URL, API key, wallet key or signature.

The ordinary Clock equality, 30-second wall-time bound, 32-slot freshness limit, mint policy, Rent and current-source rechecks are unchanged. The stock-only Clock exception does not apply. Successful evidence remains advisory mint policy and minimum token-account rent only; execution, signing and automatic-execution flags remain false.

## Verification

Eight native harness tests pass, including a real offline compiled keyless fixture using the frozen full schema, oversized/cancelled responses, no later read after refusal and source-copy corruption detection. 58 Vitest tests pass across the existing asset collector and the public fixture composition. Controlled Clock equality succeeds; Clock +1 refuses after the first account read. Successful evidence JSON serialization is tested, and rent minimums are already decimal strings. Plain TypeScript, seven-file typed lint and scoped formatting pass. These are focused tests, not a fresh full-suite or browser pass.

Two actual `claude-opus-5-5` CLI source reviews completed through Read/Glob/Grep with unchanged review copies and zero permission denials. Initial feedback led to the snapshot/schema freeze, refusal latch, configuration pacing validation, JSON serialization regression and fixed receipt-write fallback. The final 11-file source review found no concrete blocker to the one public read. Neither reviewer ran tests or a browser. A final JSDoc-only fetch return annotation and formatting correction were independently type/lint checked after its copy; executable logic is unchanged. Review limits include missing transitive sources and installed external packages; Codex inspected the actual endpoint getter, original no-retry integer-preserving transport and decimal-string rent return separately.

## One live outcome

The single Node24.19.0 run at 21:54:22–21:54:24 UTC completed as `observed`. Exactly four HTTP200 requests went to the existing configured indexer: genesis, slot and two account reads. Slots were460195284,460195285,460195286, spanning2slots. Both account-response Clocks equal their contexts (offset0). No429, retry, replacement target or endpoint switching occurred. WSOL9decimals and USDC6decimals both passed the existing classic-token policy; each165-byte account minimum decoded from the observed Rent profile was1488440lamports. Both source and frozen snapshot remained unchanged. Evidence SHA256: `67f3c15fc683fb5988c5223cae0d61dd6a059a679394ad63ecf79b8c3bf9e4a6`.

The sibling JSON retains the sanitized trace, exact compiler/schema hashes, receipt digest and public asset facts. Private full evidence and original receipt remain under ignored `work/warmup-public-assets-2026-10-22T21-54-22-739Z-2648da17/`. No endpoint, provider hostname, key or user wallet data is published. This is one asset-reader observation, not repeated provider qualification or an executed warmup.

## Remaining work

A successful public asset read cannot establish wallet custody, balances, complete gross fees/setup budget, program identity, swaps, runtime qualification, durable reservations, user approval, signing or recovery. Those remain separate requirements for the full warmup flow and Proxima parity. No application/hosted migration, protected Claude UI, provider/credential/cron change, funded test or deployment is included.
