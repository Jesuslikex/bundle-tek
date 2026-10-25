# Saved Auto Sell run recovery screen

25 October 2026. Source base `4eedabf`.

The Auto Sell modal now has a collapsed **Saved run recovery** panel. It discovers recorded runs, pages through their attempts and inspects the exact original preparation. It shows held allowance and distinguishes an unsigned retained packet, an older summary without bytes, an unknown result and an attempt that never started. It does not restore counters, release allowance, resume, prepare, unlock, sign or send.

Current tab-only runs are still not journal-backed. The panel says so explicitly; an empty journal is not proof that a browser run never happened or settled. Journal-backed signing and execution remain disabled. Existing tab-only trading controls are unchanged.

## Implemented

Identity is consulted only when recovery is expanded. Journal requests require explicit buttons; mount, disclosure, back navigation and reload do not automatically load journal records. The panel remounts and aborts pending work when its account, pending-identity state or exact project context changes, or the disclosure closes. No packet, identity, credential or progress snapshot is written to browser storage. Cancellation and timeout preserve the original IDs and charged allowance.

The flow is run list, attempts, then preparation, with back controls and focused headings. Pages contain at most 20 records. Full original IDs/hashes stay in collapsed details; raw transaction bytes are not displayed or exported. Amounts use exact integers and the run's original token precision, not the current chart's token metadata. Original quote/expiry timestamps and recorded simulation remain separate from finalized outcomes.

The strict client checks closed response shapes, exact independent run/project/attempt context, false authority flags, canonical IDs/times, complete page ordering/cursors, cumulative integer limits, summary/envelope/record hashes and original expiry. The heavier packet codec is dynamically imported only on explicit preparation inspection. Transport is bounded, GET-only, same-origin, no-store, redirect-refusing and cancellable. HTML, parser and network failures produce fixed messages rather than raw response text.

An in-memory, account/project-scoped 100-run observation map survives index reloads and paging. Complete new pages are checked before replacing any observation. Changed immutable identities, lower attempt/allowance totals or a stopped journal becoming open are refused. Canonical attempt pages advance the same observations. When preparation inspection confirms a start, both the selected attempt and its cached list marker advance. None of these observations is execution authority or persistent progress restoration.

Two explicit GET branches were added to the existing run API: `projectId&index=1` echoes its owned project; `runId&attempts=1` returns lean descending attempt pages with original token context and attempt hashes. An optional `beforeSequence` must identify an actual owned attempt. Complete canonical journal replay still happens before projection, so corruption outside the visible page refuses the entire response. The original GET branches, all POST behavior and stored journal rules are unchanged.

## Verification

**974 tests across 54 files pass**, with every assertion individually passed and the runner exiting 0. The cohort includes all matching Auto Sell library/component tests, profile/run/recovery APIs, both journal/packet engines and imported-preparation/conditional regressions, using at most two workers. This is scoped regression evidence, not the repository-wide full suite.

Plain TypeScript, nine-file typed lint and ten-file source formatting pass. Coverage includes real modal composition without vault/runner/executor invocation, actual API/Turso/disposable SQLite responses admitted by the client, all recovery states, account/project/pending identity changes, cancellation and late replies, HTML/authority refusal, forward-only accounting/Stop observations across reloads and cached start advancement. The API's 79 tests include 25-attempt paging, ownership, read-only change counts, historical Stop/archive reads and corruption outside the visible page. The client has 60 admission/transport cases.

Existing Chrome exercised the compiled actual modal/client, actual read APIs and production Turso adapter against a disposable database containing all 153 migrations. Authentication was synthetic; vault, runner, executor and provider paths were refusing fixture modules. Seven explicit saved-data GETs recovered the same packet and original expiry before/after reload; the second synthetic account saw an empty index. Database checks retain one run, attempt, start, summary and packet, with zero signing intents. At 1920 and 375 pixels, document, modal and panel have no horizontal overflow; long hashes wrap and recovery buttons are at least 44 pixels high. Password stayed empty, Run stayed disabled and no console errors were observed. The temporary viewport, own tab and own server were cleaned up.

Rendered evidence precedes the final identity-uncertainty clearing, semantic status/Link/formatter refinements and review consistency fixes. Those changes are independently unit/regression verified; no exact final-snapshot browser or real production-login claim is made. The named-column fixture correction lets the same original fixture values work with the full current schema and the older minimal engine fixture. It changes no application SQL.

Two actual Claude Opus 5.5 source-only reviews completed with unchanged bounded copies and zero permission denials. The first identified lost observation floors on index reload and a stale cached start marker. Both were fixed and tested. The follow-up verified both fixes and found no remaining concrete blocker in this read-only checkpoint. Claude did not run tests, diff the original safeguards or qualify deployment/financial behavior. The source-derived checks are recorded separately.

An earlier broad Vitest JSON run exited with its own unfinished-test warning, despite reporting zero failed assertions; five journal tests were pending. That report is explicitly invalid as a pass. The same journal file passed all 15 cases alone, followed by the complete final cohort with console diagnostics retained. No test, timing, schema, minimum, custody or signing rule was relaxed to obtain a pass.

## Preservation and remaining work

Source comparison proves the entire existing modal unchanged after removing only the new import/mount, and the entire original GET/POST unchanged after removing the two new explicit read branches. Thirty protected files, the journal and all 153 committed migration files retain their original content. The shared fixture only adds explicit column names with identical original values and bindings. No new migration number is reserved; next remains `0155`, subject to fresh claims/journal inspection, with Claude `0147` still reserved.

This is inspection, not durable automatic execution. The browser runner still keeps counters in memory. Journal enrollment for the actual runner, qualified strategy decisions, retained configuration/control epochs, fresh explicit resume consent, complete runtime/signing qualification and receipt-bound settlement or provably unsigned closure remain unfinished. A missing response never authorizes a replacement or budget reset. New pages re-read start markers from the canonical immutable server records; those local markers do not become execution authority. When a reload is refused, the prior verified index remains visible beside the error.

No production build, hosted authentication/response-capacity qualification or funded proof is claimed. No application/hosted SQL, deployment, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded action occurred. Git deployment remains disabled. Claude PR57/59/60 application files and protected parents, the four original AGENTS additions and seven frozen warmup drafts remain untouched. Full legitimate parity and read-only Jito qualification remain open.
