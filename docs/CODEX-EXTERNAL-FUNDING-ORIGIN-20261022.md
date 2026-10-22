# External funding-origin evidence prerequisite

22 October 2026. Source base `ee540ec7670df0dd17de8c2b55fca8f0f4236e08`. This is a new unmounted decoder and bounded read-only provider qualification, not an external-wallet UI or finished funding-history feature.

## Configured-provider evidence

The existing ignored local Alchemy holder endpoint passed three bounded fixed probes: full oldest-first method availability, full-versus-direct receipt consistency, then one deterministic public native-transfer source from the official documentation example. All nine requests returned HTTP200: three genesis, four getTransactionsForAddress, two getTransaction. No network retries, setting/credential change or transaction submission. The documentation example and its one deterministic transfer source are distinct exploratory targets; no alternative candidate was tried after that fixed one-hop sample was selected. Provider URLs/keys, accounts, balances and raw historical packets stay in ignored private work files.

The documentation example's own oldest transaction was not a native funding credit to that address: its native balance ended at zero. This did not become a funding result. Its one selected public transfer source supplied a finalized legacy receipt with a zero-to-positive recipient and a real native transfer. The exact retained receipt was tested offline, without another RPC request. Signature, slot and timestamp mutations all refuse. This is read-only historical evidence, not a funded execution test or complete archive proof.

[Alchemy's method reference](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-transactions-for-address) documents ascending/descending history and full/signature modes. Availability and the fixed response shapes were measured; current production plan capacity, all-wallet success and complete archive coverage were not established.

## Decoder contract

`lib/wallet-funding-origin.ts` requires a canonical prime-order wallet address and valid server observation time. Its caller must first establish mainnet on one captured endpoint, request unfiltered finalized ascending limit-one signature history, and fetch that exact signature in base64 with maxSupportedTransactionVersion:0. No production caller exists yet. Missing/malformed/failed/non-finalized oldest history stays unknown without substitution. Slot and block time must agree with the receipt; null/future time refuses.

Packet and message bytes round-trip canonically within Solana's1232-byte packet bound. Every static signer is locally authenticated with the existing strict Ed25519 verifier; signature0 must equal history. Only legacy or static-only v0 messages are considered; any address-table dependency refuses. Native System Transfer tag2 and Compute Budget tags2/3 are decoded at exact lengths and account roles, with duplicate setters and unsupported programs/instructions refused. No program ID is accepted on its own.

The decoder replays the fee and every native transfer with exact uint64 bigint arithmetic, signer/writable/readonly roles and underflow/overflow checks. Every final account balance must reconcile. A non-signing recipient must start at zero and end positive, with its complete incoming funder set retained. A missing wallet is unavailable evidence; a signing recipient is an unsupported shape; funded-again classification is made only after conservation. No token/reward effect, unknown loaded address or nonempty inner trace is accepted.

## Explicit old-recording policy

The first fixed historical check correctly refused missing inner recording under the prototype's initial rule. Opus then assessed the signed-byte proof before any admission change. Explicit null recording is now admitted ONLY after the entire authenticated message proves legacy System Transfer-only semantics, which cannot CPI. A counted proof tied to instruction count prevents future supported branches inheriting the exception. Missing/undefined recording, v0/Compute under null, unsupported System instructions, nonempty recorded inner calls and contradictory recognized invocation logs refuse. Existing Bubble Map's parsed-trace policy, group/stock/warmup guards and all signing paths are unchanged.

The public receipt actually had empty pre/post token/reward arrays and normalized empty loaded-address vectors. These remain checked. Opus's suggestion to require the loaded-address field be absent was not adopted: the observed RPC returns empty vectors even for the old legacy receipt. No undocumented era cutoff or blanket null admission was invented.

## Trust and verification limits

Local signatures authenticate the message, transfers, account identities and blockhash. They do NOT authenticate slot, block time, transaction index, pre/post balances, fee, finality, oldest-history ordering or archive completeness. These remain explicitly provider-reported (`ledgerMetadata`). Conservation checks the provider's arithmetic against the signed message; a provider fabricating consistent metadata is outside this proof. `historyComplete`, `signingAllowed` and `executionAllowed` stay false. Strict signature authentication can conservatively refuse historical packets accepted by consensus. No first-ever funding, wallet generation age, common-control or detection-avoidance guarantee is made.

The portable evidence records the final regression count and retained public check. Plain TypeScript and two-file typed lint/format pass. Initial test-only literal-array typing and an SDK fixture's lookup-index spelling were corrected; failed reports are retained. Actual Opus5.5 reviewed twice with five unchanged source copies and zero denials each, without tests or public payload access. It approved the no-CPI reasoning and found no material regression on follow-up; final diagnostic-reason corrections were independently verified, not rereviewed. The real retained-receipt check is Codex evidence, not an Opus claim.

No new Next build or browser QA is claimed: this new module is not imported by any app/API/component, and existing runtime modules were not edited. Whole-project TypeScript includes the new code. No UI, application/hosted SQL, schema/migration, provider/credential/cron change, wallet unlock/sign/send, strategy run, funded execution or deploy occurred. Existing saved-receipt timing v1 semantics remain unchanged.

## Next connected step

Implement a bounded same-origin signed-in owner/revision-checked provider-history API, using the configured endpoint and existing pacing, exact genesis and request semantics, cancellation/byte bounds and stop-on-rate-limit behavior. Then connect a separately labeled provider-history mode to selected-wallet funding gaps, with explicit provider-read progress/cost scope, cancellation, unknowns and stale-context invalidation. Never cast provider evidence into the existing most-recently-saved-receipt protocol or silently mix source meanings. Full external coverage, marketplace age qualification and the broad Proxima goal remain open.

Ignored reports: `work/release-qa/funding-history-full-{capability,consistency}-20261022.json`, `funding-history-one-hop-probe-20261022.json`, `wallet-funding-origin-{initial,extended,reviewed,regression,final}-20261022.json`, `wallet-funding-origin-live[-verified,-final]-20261022.json` and `opus-wallet-funding-origin[-followup]-20261022/`. The actual public historical fixture stays private and ignored; only its hash and redacted outcomes are portable.
