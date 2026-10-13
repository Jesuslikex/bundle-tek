# Counter trigger semantics and implementation requirements

Subsequent verification: the full-suite handle referenced below is now terminal, with 2153 tests across 307 files passing and unchanged source hashes. The source freeze has ended; see CODEX-CURRENT-FULL-SUITE.md. Counter remains unimplemented. The following capture/checkpoint notes retain their original scope.

13 October 2026. Fresh REA menu inspection adds **Rate (%), Min. SOL and Min. Token** to the observed Counter Trading choices. The menu was opened without selecting an option or filling any input. Escape left it visible; the actual Close button removed the form, and a separate completed scenario restored the account route.

## Documented intended behavior

The [official Auto Buy / Auto Sell documentation](https://docs.proxima.tools/live-settings/auto-buy/), checked today, clarifies:

- Rate is response probability; quote/token minimum modes filter observed trade size.
- Replication Factor scales the response relative to the observed trade.
- The minimum per trade accumulates amounts before trading, independently of the trigger filter.
- Whitelist excludes addresses, with launch-plan wallets included by default.
- AutoBuy responds to sells; AutoSell responds to buys.
- Strategy and global session limits stop their respective scope at the first amount or duration limit. Pause, resume, edit and End are documented.

These are vendor-defined semantics, corroborated in part by the live controls, not observed execution or custody behavior. The earlier report's uncertainty about probability, accumulation and whitelist direction is narrowed by this documentation; backend verification is still absent. Exact atomic rounding, input/output denomination, net-versus-gross trade amount, default exclusion expansion, probability sampling, batching, finalization accounting and duration clock anchor remain unresolved.

## Bundle design implications

The following are implementation requirements inferred for Bundle, not claims about Proxima code:

1. Persist each eligible observed trade identity and its decision once. Retrying an observation must not reroll probability or double-add to an accumulator.
2. Keep observed-trade filtering separate from buffered response amounts. Do not discard a valid small contribution merely because it has not reached the response minimum.
3. Name excluded actors plainly and bind owned-wallet exclusions to a reviewed account context. Do not implement the documented whitelist as an allowlist.
4. Maintain separate strategy and session reservation/settlement accounting. Signed/submitted allocations require recovery evidence, even after a stop or context change; they cannot silently become free budget.
5. Build reviewed immutable proposals through the existing vault, fresh preparation and separate submission consent. An accepted signal is not signing authority. Unknown classification/denomination must remain ineligible.

This note supplies requirements for actual Counter implementation, not a substitute planning-only feature. Bundle Counter, multi-strategy coordination and the full goal remain incomplete. Application/test source stays frozen for the current combined suite.

## Evidence and verification boundaries

Complete records and manifest are retained at C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/work/proxima-counter-trigger-menu-20261013:

- trigger-menu.json: ev_ac92dd8772ce3e3a37b6a3d8733535fd468625d9f18df417994253a4fe32fa68, 618912 bytes, SHA-256 d3f68d8b078027e06abadad688c6823a19d47a184770e3a13bfcb89a6e910f00. All four actions completed; final capture has no Auto Sell heading. The immediately captured opening step was still loading, so the later populated menu state supplies the actual control evidence.
- restore-account.json: ev_c42418430cf52e44a9da39c91e4be54fdfd852857e9cbb7dc769f99a17949462, 9665 bytes, SHA-256 7e779249c9038f9b987bd114ca0e69a4e3a83365861bb1b714fd5d0fe00b246e. Both steps completed at the original account URL with no Auto Sell form heading.

Complete Evidence was saved in bounded data-only parts, reassembled and JSON/identity verified. Event coverage is incomplete. No raw body/header value, credential, cookie, storage value or screenshot was exported. No input value, wallet selection, Add Strategy, Run, signing or trade control was invoked.

The same full-suite handle 75317 remains active. Thirty-two passing files were observed at this checkpoint; terminal totals/report and final source verification remain pending. The 1056-file source digest still matches 7593e0ccc5b2f76f0c1475b7a988378b73841301e82a2fcb5b98ce05006bb5fd. Only documentation changed; no protected Claude source, migration, hosting candidate, provider or scheduler changed. Nothing pushed, deployed, saved as a hosting version or transacted.
