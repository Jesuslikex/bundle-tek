# Coalesced stock-pair account snapshots

16 October 2026. Local continuation after 1fdd264. Production remains d62300e.

## Implementation

The new bounded order-state reader requests the wallet, selected source/destination accounts, protected intermediate accounts, both selected mints, intermediate mints and Clock in one confirmed getMultipleAccounts response. It permits at most 22 distinct keys, validates the exact ordered mapping and request floor, and requires Clock to name the returned bank. All mint policies and full protected account bytes come from that response. Undefined/missing positions, overlapping scopes, unsupported mints, malformed clocks and more than 32 slots are refused. Missing token setup accounts remain representable as null; missing mint policy does not.

The order collector uses one such snapshot before simulation and one after simulation, replacing the separate protected-account, selected-mint and optional intermediate-mint reads. Existing account identity, nonnegative intermediate units, native debit/rent/refund conservation, fee, lookup, network, lifetime, expiry and owned-context checks remain enforced. The complete runtime still performs one traced simulation between two full code observations and rechecks final protected custody after code collection. No code identity, signing or execution permission is inferred from coalescing.

Wallet preflight now includes both mint accounts in each existing wallet/account/Clock snapshot and independently verifies their policies in that same bank. The two standalone preflight mint requests are removed; both wallet snapshots still inspect actual current mint bytes and clocks. The complete quote/wallet span includes the original quote mint-policy slot. The response format and funding/signing flags are unchanged. Tests require four getMultipleAccounts calls for preflight (two quote-policy snapshots and two combined wallet snapshots), compared with six previously. With one intermediate, the order collector replaces three account/mint requests per stage with one, saving four further RPC calls.

The ordered mapping and configuration follow [Solana's getMultipleAccounts documentation](https://solana.com/docs/rpc/http/getmultipleaccounts), inspected on 16 October. This is a provider-observed bank response, not a cryptographic account proof or an atomic guarantee across separate before/after requests.

## Verification

The focused run passed 223 tests in eight files. The final combined run passed 742 tests in 32 selected files together in 242.19 seconds. Production Next webpack build, subsequent standalone TypeScript, ten-file typed lint and whitespace checks pass. All 1,277 implementation/configuration/style hashes remained unchanged throughout final verification. The repository-wide suite and the full group selection were not rerun; the shared group code collector itself is unchanged from 1fdd264, whose separate 25-file/243-test group qualification is documented in the preceding handoff. The current selection includes the existing shared group runtime regressions.

New tests cover exact one-response mapping, the 32-slot boundary and invalid/below-floor contexts, malformed/missing mint/Clock data, immutable request scopes, duplicate/oversized scopes, actual late mint-policy changes in the second wallet response, and request-count reductions. Existing wallet-bound packet, native/SPL/Token-2022 intermediate and real owned API tests remain exercised. Fixtures were updated to return the new exact mint/account mapping; their Clock bytes still have to match response.context.slot.

Ignored receipts are work/pair-state-{focused,tests,build,types,lint}.log, the selected-file list and source-freeze manifest. Test signatures/provider data are synthetic. No UI file changed; Claude's market/page/layout ownership remains in force.

## Live limit and next optimization

The known public reference was unsuitable on recheck, so that probe stopped before constructing a project or requesting a quote. A fresh bounded historical-transaction reference then reached runtime inspection but stopped at selected mint evidence spanning slots 457419989 through 457420024 (35 slots), with matching policies. The 32-slot guard remained intact; the latest sequence did not reach simulation. No live full runtime preview or signing qualification is claimed. The probe used isolated local SQL, allowlisted public mainnet reads and unsigned Jupiter GET requests. No user wallet, private key, signature, broadcast or production database was involved. Ignored receipts: work/pair-state-v1-live-transaction* and work/pair-state-v2-live-transaction*.

A separate read-only rent proof at 2026-10-15T23:34:14.999Z (16 October local time) matched on-chain Rent data against the existing independent rent RPC for six sizes. The current observed profile was 5,080 lamports per byte, exemption threshold 1 and burn percent 50; slots 457422423 through 457422430 retained identical Rent bytes. This is a captured profile, not a permanent network constant. The Rust [solana-rent implementation](https://docs.rs/solana-rent/latest/src/solana_rent/lib.rs.html) supports exact integer calculations for thresholds 1 and 2 with 128 bytes of storage overhead; [Agave's bank method](https://raw.githubusercontent.com/anza-xyz/agave/master/runtime/src/bank.rs) applies a minimum of one lamport. These mutable primary sources were inspected on 16 October, not used as proof of the deployed validator binary.

| Account bytes | Observed RPC minimum / independently calculated lamports |
| --- | --- |
| 0 | 650240 |
| 82 | 1066800 |
| 165 | 1488440 |
| 179 | 1559560 |
| 200 | 1666240 |
| 4096 | 21457920 |

Public capture for a future rent-reader fixture: SysvarRent111111111111111111111111111111111, owner Sysvar1111111111111111111111111111111111111, executable false, data ["2BMAAAAAAAAAAAAAAADwPzI=", "base64"], space 17. Full ignored receipt: work/pair-rent-proof.json. No rent calculation has replaced the application RPC yet. The next step is to incorporate validated Rent evidence into these same bank responses and qualify exact conservative rent handling before removing the remaining rent calls; code collection still also needs fewer actual RPC calls under the preserved provider pacing.

Stock-pair signing remains disabled. Runtime qualification must precede separate unchecked approval, durable currency-aware reservations, browser-only signing, one send attempt and finalized-receipt recovery. Any Claude-owned layout slot needs an exact patch for approval first. No funded mainnet test without user approval of that specific trade. No migration/remote SQL, provider/credential setting, cron, push or deployment changed. Main's two unrelated dirty files remain protected.
