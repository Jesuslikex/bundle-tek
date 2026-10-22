# Selected-wallet funding history and close-time warnings

22 October 2026. Source base `5f3186b9bd8160eef261d1d11ba50ac76af2dfca`. This connects the previously reviewed native funding decoder to an owned API and the existing selected-wallet panel. The portable evidence file records the final validation and exact source hashes.

## User-visible behavior

Select Solana wallets, choose Saved receipts or Provider history, then explicitly start the check. There is no mount read, automatic retry, funding, signing or transaction submission. The existing red clock and expandable red text show the nearest gap strictly under 30 minutes, including `24m 34s apart`; exactly 30 minutes stays outside the warning. Missing evidence stays unknown with a keyboard-accessible explanation. Similar timing is not common-control proof.

Saved receipts retain their original v1 protocol and most-recently-saved finalized native SOL event semantics. Provider history has a separate strict DTO: oldest transaction returned by the configured provider, supporting a fully decoded initial native SOL deposit. Earlier history may be missing. Times, balances, slot, transaction index and finality remain provider-reported, and historyComplete/signingAllowed/executionAllowed remain false. The sources are not merged or cast into each other.

Provider mode reads at most 100 selected wallets in groups of ten. It shows progress and a 17-second wait after each completed group, with Cancel and focus recovery. Source/selection changes abort work, discard results and explain cancellation. This includes search/folder changes that alter the protected parent's visible selected rows; the parent was not edited. A later group failure discards partial results and explains that a fresh check rereads the full selection. A-to-B-to-A selection changes never revive stale results.

## Server and transport boundary

The new POST requires verified sign-in, same origin, JSON under 12000 bytes, exact owned active Solana addresses and current revisions. Every group carries the entire original selection context, which is rechecked before work, after genesis, between wallets and before delivery. Revision drift in a wallet read by an earlier group refuses the later group too.

Only an explicit existing server SOLANA_HOLDER_RPC_URL on the qualified Alchemy mainnet HTTPS hosts is used. There is no indexer/public fallback, no request-supplied endpoint and no settings or credential change. Mainnet genesis is checked on that captured endpoint. The fast path uses one genesis read, up to ten ascending finalized limit-one full/base64 history reads, then one getSignatureStatuses batch with searchTransactionHistory:true. Maximum twelve RPCs per group. Actual status must be finalized, successful, null-confirmations and exact-slot-matching, with a context at or after the receipt. A partial status array fails; unavailable individual status remains unknown.

The existing strict native decoder still authenticates all canonical signatures and replays every supported transfer plus fees with complete uint64 balance conservation. Unsupported routes, lookup dependencies, missing oldest evidence and non-initial deposits never fall back to a newer transaction. The narrow previously reviewed legacy native-transfer no-CPI proof is unchanged. No program is accepted by ID alone.

The metadata read has a 45-second server budget, 50-second client group budget and 700-second finite campaign budget. The per-fetch eight-second timer starts after existing configured RPC pacing. The history-only transport rejects redirects, wrong numeric request IDs, malformed UTF-8/JSON and responses over 512 KiB; integer parsing preserves balances beyond Number precision. The client admits at most 1 MiB. No provider error text, endpoint, key or raw packet is returned.

The existing gates table provides a namespaced 60-second owner lease. Exact-value CAS cleanup installs a 15-second post-completion cooldown and cannot shorten a newer lease; failed cleanup leaves the conservative expiry. A 429 stops without retry and has conservative Retry-After:60. DB calls themselves cannot be cancelled, but every provider call checks the bounded signal before starting and after awaiting; late DB completion cannot start additional expired provider work. Pacing is per process and exact endpoint, not an account-wide quota guarantee. The 17-second inter-group wait adds a two-second clock margin; arbitrary server clock skew or provider throttling can still refuse.

## Verification and review

Final regression: 204 tests across 19 files, zero failures/skips, including original saved receipts, workspace, Bubble Map, real HTTP transport, synthetic signed native packets, native in-memory owner/revision/gate queries, ten-wallet maximum configured pacing, greater-than-eight-second queue waits, cancellation, exact response binding and focus recovery. Plain tsc --noEmit, sixteen-file typed lint and seventeen-file formatting pass. Controlled timers explicitly prove the fetch timeout is created after pacing. This is a focused regression, not a new whole-repository test run.

Two actual claude-opus-5-5 source-only reviews completed with 21 and 27 unchanged copied files, zero denials and no edits/tests/network. The initial round identified timing and transport coverage gaps, which were corrected. The follow-up found no blocking decoder/DTO/lease/transport issue. Its selection-cancellation, clock-margin, numeric ID, Retry-After, timer-test and focus follow-ups were independently verified in the final regression, not rereviewed. Group/warmup/stock runtime checks and all protected Claude files remain unchanged.

Four additional existing-provider read-only RPCs returned HTTP200: two genesis, one full base64 history, one signature status. They use the same fixed public native-transfer source from the prior one-hop fixture, not an owned wallet. The full packet and slot/time match the retained historical packet; status is finalized with matching slot/context. The new adapter accepted that retained packet and refused status mutations offline with zero additional RPCs. This is historical read-only evidence, not a funded execution test, all-wallet guarantee or complete archive proof. The previous prerequisite's nine RPCs are separate. Private payloads, accounts, balances, signatures and URLs stay ignored; only redacted outcomes are portable.

The final isolated Next production build passed with all seventeen overlay hashes unchanged. It used a clean archive plus exact owned overlays, a node_modules junction and a sanitized environment with no copied .env files. The multiple-lockfile workspace-root warning is retained; no configuration was changed to silence it. Build success does not prove live provider configuration or signed-in rendering.

Chrome inventory timed out. DOM tests establish interaction behavior, but current rendered desktop/mobile and signed-in app QA remain open. No production release or live availability claim is made.

## Boundaries and next work

No migration, schema or financial writer change. No application or hosted database was executed during this work; only disposable in-memory fixtures ran. No provider/credential/cron change, real wallet unlock/sign/send, strategy run, funded execution test or deploy. Existing server metadata gates will be written only when this endpoint is explicitly used in a running app. Git deployment is disabled.

Next: rendered signed-in desktop/mobile verification when the existing browser connection works, then broader reference coverage and unsupported native-history routes. Full Proxima parity, complete archive/funding coverage, marketplace age qualification and automatic warmup execution remain unfinished. Migration journal remains 0136; next free number is 0137, subject to recheck.
