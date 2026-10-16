# First fixed QuickNode stock-runtime sample

One fixed three-round alternating SOL/USDC campaign ran on committed `ebdcba6` with Node24.19.0, starting at18:45 UTC on16October2026. The existing per-asset public-reference fixture was pinned before starting. QuickNode's already-approved endpoint was supplied only to the child campaign environment; no local provider file or Vercel setting changed. The private transfer file was removed before the campaign started. Reference discovery/activity audits stayed on the existing indexer; stock runtime account, Clock and order-evidence reads used QuickNode. There was no retry, replacement, reference rotation, signing, send or deployment.

## Complete denominator and exact refusals

| Attempt | Asset | Outcome |
| --- | --- | --- |
| 1 | SOL | Wallet evidence getMultipleAccounts refused HTTP413:7 requested accounts, no slice, floor457742178. No simulation/code scan. |
| 2 | USDC | Strict initial minimum refusal: original283168 raw, packet283071 raw. No simulation/code scan. |
| 3 | SOL | Strict initial minimum refusal: original29196 raw, packet29195 raw. No simulation/code scan. |
| 4 | USDC | Wallet evidence getMultipleAccounts refused HTTP413:8 requested accounts, no slice, floor457742256. No simulation/code scan. |
| 5 | SOL | Wallet evidence getMultipleAccounts refused HTTP413:7 requested accounts, no slice, floor457742287. No simulation/code scan. |
| 6 | USDC | Wallet evidence getMultipleAccounts refused HTTP413:8 requested accounts, no slice, floor457742316. No simulation/code scan. |

SOL0/3 and USDC0/3. All six before/after reference activity audits were unchanged, all six source vectors match current source, and the offline six-receipt summary recomputes exactly. The two economic refusals are the strict initial quote/order check; the user-approved fresh-reference-only tolerance does not override it. No guard was loosened to make a sample pass.

Campaign transport:118 HTTP200 and four413, zero429. QuickNode runtime:54 HTTP200/four413; existing indexer:48 HTTP200; Jupiter:16 HTTP200. Maximum rolling admission was6 RPC methods/second per receipt, inside9. All26 accepted Clock observations were equal; each correlates with two actual, matching40-byte response hashes in a single raw response from the stock runtime endpoint. Maximum observed absolute Clock/server skew was1570ms, inside the unchanged30-second bound. There is no complete +1 live path, simulation, first/final code collection or32-slot qualification result in this sample. Early refusals do not establish runtime latency or repeatability.

## Bounded diagnosis after retaining the sample

A separate two-call probe used only repeated public Clock accounts to isolate request account count. Five accounts (345 request bytes) returned HTTP200 with five results. Six accounts (391 request bytes) returned HTTP413, JSON-RPC error-32615: `getMultipleAccounts is limited to a 5 range, upgrade from discover plan at [URL] to increase the limit`. The endpoint remained on the user's Free trial. The complete sanitized probe is retained beside all six original receipts in CODEX-PAIR-QUICKNODE-FIXED-SAMPLE-20261016.json. This establishes an actual endpoint method-count limit, not excessive JSON request bytes or a Clock refusal. The public [general method reference](https://www.quicknode.com/docs/solana/getMultipleAccounts) lists larger general limits; it does not override this trial endpoint's observed refusal.

The full wallet observation needs7 or8 accounts, including two actual Clocks. No Clocks or account checks were removed, no paid upgrade was selected and no endpoint/security setting changed. A compatibility implementation must fit each actual provider call within5 accounts while retaining every original observation, request identity/floor, byte bound and paced method count. It must explicitly preserve observation-context semantics. Concatenating chunks from different slots and publishing their maximum as one original snapshot would be unsafe and is not implemented. Any split-read design needs review and deterministic partial/reordered/stale/Clock-disagreement tests before another separate fixed live campaign. The final code recheck,32-slot bound and group serial reads stay mandatory.

## Verification and handoff

The preceding raw-wire logging correction is separately committed as ebdcba6. Its Node syntax check, scoped lint/format and21 offline harness tests passed. This turn's sample is verified by source/receipt/campaign hashes, exact offline summary recomputation and all26 raw Clock correlations. No application source changed; no unchanged full app suite, group suite, build or browser execution proof is claimed. A private endpoint details tab was used only to read the approved URL, without printing it. The temporary credential files are absent after both campaign and probe.

The first configured-validator sample remains failed, with every refusal retained. Signing/trust/execution gates remain false. No user wallet, key, signature, transaction submission, SQL, cron, provider configuration, paid plan, Git push or deployment. Claude-owned files and main's two unrelated dirty files remain intact. Full Proxima parity is still incomplete; this diagnosis must not be described as qualified stock trading.
