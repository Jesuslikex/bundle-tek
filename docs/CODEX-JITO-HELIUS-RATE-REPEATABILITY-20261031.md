# Helius unsigned CPMM repeatability

31October2026, base ace35e2, existing draft branch
codex/jito-v2-reservations-20261028. Local read-only research only. No deployment,
provider/credential/cron change, hosted SQL, wallet unlock, signing or broadcast.

## Final fixed sample

**3/3 complete unsigned Raydium setup/swap bundles passed, 27/29/30slots, no429.**
All relevant source hashes remained unchanged across the campaign and were
independently compared with the final source. Two-second cooldown BEFORE each
new attempt's original F, never inside an old observation window. No retries,
discarded outcomes, replacement attempts or packet/code-scan reuse.

| Attempt | Receipt timestamp | Original F | Simulation | Final slot | Span |
| --- | --- | --- | --- | --- | --- |
|1|1793422489650|463561401|463561414|463561428|27|
|2|1793422498794|463561443|463561457|463561472|29|
|3|1793422508010|463561485|463561502|463561515|30|

Each29HTTP/33methods, four zero-signature transactions, both full source-matched
code scans, exact independent fees, tip, ATA Rent, source/output token accounting,
pool/vault/config/oracle replay, unchanged payer/source custody, mint policy,
independent market comparison, exact Clock/30second wall bound and blockhash
validity/10block margin. Original F..F+32 remains unchanged.

This is a bounded repeatability result for the approved **provider-trusted unsigned
research** profile. It does not establish immutable bank/fork attestation, owned
wallet authorization, universal provider capacity, funded execution or production
readiness. ProviderQualified, fullSwapQualified, bankIdentityVerified,
feeBankIdentityVerified, signingAllowed and executionAllowed remain false.

## Changes and evidence

1. The existing dedicated qualification queue is retained. A stricter local wire
   guard admits at most8methods/1250ms, plus150ms per method after admission.
   A five-method batch is charged five together and leaves a750ms post-batch
   gap. This adds headroom under the original9method ceiling; ordinary wallet
   queues and global settings are unchanged. Across all nine new attempts the
   recorded peak was7methods/1000ms and8/1250ms. Helius documents10RPC requests/s
   for its Free tier; the current account's plan or other traffic is not inferred
   from that table. See the primary rate-limit reference below.
2. Rate refusals now include documented JSON-RPC -32005 with rate-limit text,
   not just429. A lagging-node -32005 stays a different refusal. Lossless bigint
   wire codes work; classification reads bounded data properties, exposes no
   provider message and never grants admission. Quota/credit refusals stop too.
3. HTTP429 bodies are captured only through an8192byte/1500ms bounded reader,
   when parseable, with raw hash in the ignored receipt. Public diagnostics keep
   only category/codes/numeric Retry-After. Pending admissions recheck the stop
   condition after pacing; owned cancellation stops outstanding reads. No retry.
4. A fixed three-child campaign records each result, startup/output failures,
   source hashes and stop reason. It stops at the first429, holds a2second
   outside-window cooldown and does not alter financial flags. No stderr text,
   URL or credential is copied into its public output.
5. The old public reference payer's observations differed by5000lamports before
   simulation. It correctly refused. A bounded public discovery using the existing
   Alchemy holder endpoint examined2x100WSOL accounts in8reads, then selected the
   first eligible observed candidate with the latest returned wallet/source
   signatures older than300seconds. Actual ages358/359seconds at discovery.
   New fixed public reference:2yik7ZsLfFKAmmr9cCHhL1dTabiECnFKDeSVyTbxeETU.
   This is NOT a Bundle wallet or an ownership/whole-history/continued-idleness
   claim. No wallet was created, funded, imported or modified. Every actual run
   still requires exact custody and its real balance/minimum/reserve checks.
6. One redundant opening-state RPC was removed. Only the v2 unsigned runtime
   profile requests165byte inventory slices, enough for complete classic-token
   custody; original/default/group profiles still request128bytes. An issued,
   immutable, reader-bound accessor exposes the actual single opening response
   at its ORIGINAL context slot, never the later scan maximum. The same exact
   Clock and custody checks consume those observed bytes. Full code scans are
   still separate, complete, serial and mandatory. Generic byte/account bounds
   and financial predicates were not widened.

## Every campaign outcome retained

| Revision | Attempt1 | Attempt2 | Attempt3 |
| --- | --- | --- | --- |
|Headroom pacing, old public reference|pass29|custody refusal|pass29|
|Quieter reference, duplicate opening RPC|pass28|pass30|Clock refusal|
|Issued opening response reused|pass27|pass29|pass30|

The custody refusal's payer was8446160lamports in both opening/fresh reads and
8441160in the simulated pre-image. No balance correction was applied. The Clock
refusal was context463560073 versus Clock463560074, with about1014ms timestamp
skew; the slot rule correctly refused. No +1 allowance or time-bound change
was introduced. The final optimization removes a duplicated read; it is not a
retry of a rejected response or an override of Clock equality.

All nine outcomes had no rate limits. This does not prove the old429's precise
upstream cause: its final response was not captured in the older recorder.
A new single-call health observation returned200/mainnet; it did not read account
billing data. The changes address observable client pressure and error handling,
not a guaranteed cure for future quota exhaustion or competing traffic.

The companion JSON includes all three campaigns, original frozen source hashes,
summaries, timings, bounded reference-selection evidence and actual request/reply
hashes. Available raw hashes, absence of send methods and every simulated packet's
zero signature bytes were independently verified. Raw bodies stay in ignored work
files, never published with credentials. Prior17outcomes remain in the earlier
CODEX-JITO-CPMM-HELIUS-20261031 report.

## Verification and operation

429tests/21files pass together on Node24.22.1, plus whole-project TypeScript,
11file typedlint and format checks. Tests cover weighted/rolling admissions,
concurrent batches, cancellation, HTTP/JSON-RPC/quota classifications and one-read
subprocess stops. The campaign's rate-limit stop is exercised with mocked fetch.
Opening provenance tests prove165bytes, original slot102 versus later scan104,
detached returned images, and refusal of foreign readers, cloned captures and
other profiles. Existing fee/pool/mint/Rent/price/lifetime/frame/default-pacing
tests remain in the passing regression scope. No full-app/browser/build claim.

```powershell
node --env-file=C:/Users/Julian/Desktop/Bundle/.env.local scripts/qualify-jito-cpmm-campaign.mjs --live-readonly
```

An error is retained, not retried within an expired packet window. Nothing in
this checkpoint enables signing, submission, production configuration or an
application route. Preserve the separate recovery-password drafts.

Primary references:

- https://www.helius.dev/docs/billing/rate-limits (RPC limits and -32005 error shape)
- https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-program-accounts-v-2 (bounded pagination for read-only reference discovery)
