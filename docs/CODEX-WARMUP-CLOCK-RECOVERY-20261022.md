# Warmup saved-request clock recovery

22 October 2026. Source base: `349c555bd08f125166995e9b8149b6c7d666ff5e`.

## Change

The existing v2 journal rejects a history root or event whose timestamp is ahead of the application server's clock. Attempt recovery previously converted that temporary disagreement into a generic integrity 503; discovery also lost its specific explanation. A dedicated static error now survives the attempt reader and maps to a no-store 409 in the preview, runtime and saved-history routes.

The panel accepts only the exact static response shape. It preserves the original request reminder, states that history has not been fully verified, and names either **Recover unsigned request** or **Find saved requests**. There is no automatic retry, new request ID, renewed deadline or execution authority. Arbitrary server/provider text is not displayed.

Both timestamp predicates and their position in replay are unchanged. This concerns application-server time, not Solana's on-chain Clock. All custody, minimum-output, freshness, reservation, consent and signing checks remain unchanged. The older journal API retains its original response. No migration is added or changed; next unclaimed number remains 0137, subject to a fresh check.

## Verification

- Regression baseline reproduced five server/library failures and two panel failures before the mapping fix.
- Final related cohort: **238 passed, zero failed, one skipped, 13 files**. The skip is the existing opt-in real-SQL-clock expiry test.
- Root-time conflict preserves the same lease and expiry. A separate read-side fault test reaches the event-time guard while the root is in the past; after time catches up, the unchanged digest/head checks reject the corrupt response with 503. The disposable database itself is not modified by the fault.
- Panel tests cover recovery GET, discovery, a refused POST, exact original reminder retention, absence of automatic retries, and rejection of spoofed clock messages.
- Plain `tsc --noEmit`, typed lint and formatting pass for the 12 changed source/test files.
- Isolated `next build --webpack` passes from the committed base plus the exact 12-file overlay, without copying environment files. All overlay hashes remain unchanged. A 2,384-file source freeze also matches.

Local ignored evidence: `work/release-qa/warmup-clock-recovery-final-20261022.json`, `warmup-clock-recovery-final-freeze-20261022.json`, and `warmup-clock-recovery-final-build-20261022/result.json`. Portable summary and source hashes are in the sibling evidence JSON.

## Actual Opus 5.5 review

The completed read-only CLI review used only `claude-opus-5-5`, with Read/Glob/Grep, zero permission denials and unchanged source. It found no blocking/high issue within the supplied files. It independently confirmed typed propagation, abort precedence, static responses, preserved predicates and absence of new authority or retry paths. It ran no tests; Codex ran the checks above.

Its event-time coverage and POST wording findings were addressed after review with the additional test and clearer text, then independently tested. Those follow-ups were not reviewed a second time. Route-level clock tests exercise GET paths; POST uses the same route failure mapper, and its clock-refusal panel behavior is tested. The runtime-ID clock case intentionally reaches the guard before mode admission and is not proof of a valid runtime-purpose lease. Some fixture provider spies in the GET tests are not connected to route execution; their negative assertions are not provider-path evidence.

Review scope excluded consent-loader internals, provider/runtime fixtures and wider callers, SQL, deployment, Auto Sell and full warmup execution qualification. Local review artifacts: `work/release-qa/opus-warmup-clock-conflict-20261022/`.

## Fresh Proxima reference and remaining gap

REA passively captured the user-opened RipéMon live page in the approved Chrome profile. Evidence ID: `ev_77d150a714a3bf742d5b98daaa0e0c80bf4b1af6de5f16e6329eecfb821f3b70`. The same-origin accessibility capture was not truncated; it excludes script sources, storage, bodies and console text, and sees network activity only after attachment. No clicks, navigation, strategy actions or wallet controls were performed. The temporary relay was stopped afterward; Chrome remained open.

Structural observations: an embedded financial chart, market statistics, wallet groups including MEV wallets, My Wallets / Latest Trades / Holders / History / Bubble Maps views, Buy/Sell controls, AutoSell, AutoBuy and Volume Bot. CARDS is displayed separately from SOL balances. These observations guide parity; they do not verify the prior funding sequence, transaction ordering, profit, backend provider or automation execution. No account balances, wallet identifiers or trade amounts are published here.

Full Generate Activity is still incomplete. The current v2 journal records begin-review/pause/resume/stop, binds the first action and reports zero completed actions. It needs guarded per-action outcomes, receipt-linked progress, budget/baseline advancement and linked Buy/Sell settlement before an execution bridge can safely advance the sequence. The broader Opus boundary review is a scoped design input, not execution clearance. Automatic signing and Start remain unchanged and off for this path. No new rendered-browser check of the recovery panel is claimed in this checkpoint.

No protected Claude shell/layout files, providers, credentials, cron, application/hosted SQL, real wallet, signing or funded actions changed. No deployment was run.
