# Auto Sell response admission and recovery

22 October 2026. Source base `ee84038273455a2401d0e250fe2d3226c4ebd5b4`. This corrects the existing Auto Sell executor's response boundary. It does not enable a new strategy, qualify funded execution or complete Proxima parity.

## Reproduced problem

The old executor compared the returned signature but ignored registration/submission state. Synthetic HTTP200 replies with a matching signature and a wrong or missing state could be treated as an acknowledged sale. In particular an already-submitted/finalized registration could cause a redundant submit POST, although the unchanged server's one-send guard would refuse the duplicate send. The old response.json() call also had no explicit content-type/byte/UTF8 admission or post-body deadline check in the executor itself.

The retained initial baseline has fifteen failing new regression cases on unchanged production source: twelve wrong/missing-state cases, an oversized streamed body, JSON served as HTML and a late review body. These injected response tests establish client admission problems, not an observed mainnet incident. Browser fetch normally enforces its abort signal on native response bodies; a synthetic stalled body is not proof that real browser Stop was universally broken.

## Corrected behavior

Each existing request now checks cancellation before dispatch, uses cache:no-store and redirect:error, and consumes a bounded one-MiB JSON object through the existing fatal-UTF8/cancellable reader. The same combined Stop/40-second deadline covers headers and body, and is checked before response admission. Invalid successful bodies become a static Auto Sell error; non-JSON error bodies retain bounded status handling without exposing raw parser or HTML text. Existing bounded pre-sign rate retries remain unchanged. Register/submit are still never rate-retried.

Only an exact matching signature with registration state signed can lead to a new submission. An already submitted/finalized registration or any other state remains unresolved and directs recovery of the original approval, without another submit POST. Only exact submitted plus matching signature and a successful response acknowledges submission. This is not finalized settlement evidence.

Every failure after the synthetic/local signing boundary retains the same frozen signature, preparation, intent, wallet and project reference in AutoSellUncertainError. It never switches wallets or retries submission. Stop before or during an unreadable registration remains conservatively charged/unresolved rather than clearing signed exposure. The old NotSent exception/expiry comment was removed. This can reserve more budget than a definitely unsent packet actually used; manual original-ID recovery is still required. No automatic cancellation, allowance refund, reconciliation or replacement was added.

Stop still prevents starting a new send. Once submit has started, its original independent 40-second deadline is awaited even after Stop, with one attempt and the original uncertain result on timeout. Runner/evaluator, spending calculations, wallet locks, signApprovedWarmupPacket, backend authorization/receipt/SQL rules and API routes are unchanged. The existing server review can reserve an awaiting-signature approval before a reply becomes unreadable; saved Sell history remains the manual discovery path. Automatic recovery of that pre-sign server reservation is still open.

## Verification

Final focused regression: 300 passing tests in 27 files, zero failures or skips, including actual executor/runner/modal/history/shared-reader and signer tests. Whole-project plain TypeScript, three-file typed lint and formatting pass. New transport tests use synthetic responses and a stub signer; they never unlock a wallet or submit a real transaction. Exact counts/hashes/reviews/build appear in the portable evidence.

Tests explicitly bind stages with promises, not arbitrary microtask waits, and cover invalid/missing states, already-recorded registration, mismatched signatures, signed-stage502/429/HTML, body size/UTF8, pre-request Stop, stalled registration cancellation, a review body deadline and a submit body deadline after Stop. Every signed-stage failure keeps the original reference and one wallet; a started submission is not cancelled by the caller's Stop.

The first corrected run reported twenty passing assertions but exited1 because the test's delayed producer tried to enqueue after stream cancellation. That fixture was corrected to honor cancellation; the failed run is retained. The final expanded run exits0. Existing registration fixtures now reflect the real route's signed acknowledgement rather than incorrectly returning submitted for both register and submit.

Two actual claude-opus-5-5 source-only reviews completed with fourteen and sixteen unchanged copies and zero denials. Initial low findings and test gaps were addressed. The final focused pass found no blocking/high bug or authorization relaxation and confirmed original-reference uncertain recovery, exact states and no signed resend/wallet failover. It still identifies the known pre-sign reservation limitation, stub-signing scope, the microtask-gap defense-in-depth test gap and absent whole-provider payload-size proof. Codex independently ran the tests. The final isolated Next production build passed on the exact three unchanged overlay hashes with a sanitized environment and no copied .env. The multiple-lockfile root warning is retained, not silently fixed. No claim of rendered/live/funded verification follows from that build.

No current rendered browser or live provider/funded qualification is claimed. The explicit one-MiB cap intentionally refuses unusually large preparation replies; no all-provider preparation-size guarantee has been measured. Server routes and their guards were read as contracts, not changed or certified through these transport tests.

## Fresh reference evidence

The approved Proxima Chrome listener was already open. The existing temporary loopback/stdio WSL relay restored REA access without launching Chrome or changing its profile. Current target-list evidence: ev_43f7b46179fe8cbec9c07368ec4e5e58dbc48af6ce2d1bbd713c253693057faa. Passive page evidence: ev_b948ccfb090963133922201e0c2723845fd9e487727059754028f9c9870b381b. Observed non-personal controls include wallet import/funding, split view, holders, history, Bubble Maps and strategy Configure/Edit/End. No control was clicked, no page navigation or JavaScript evaluation performed, and no private values reproduced here.

The private eight-record evidence bundle is retained at /opt/rea/results/proxima-live-response-review-20261022.json: 3451497 bytes, SHA256 087727829e5c5f0ebc5af867886dff922753f076ddf69d9e012a7c7757b1cf55. Eight records include retained session records beyond these two new observations; zero unknowns does not prove complete feature/network coverage. The observation excludes script sources, raw payloads/cookies/storage values and pre-attach events. The owned relay was stopped by verified exact Python PID after its stdio closed; Windows Chrome remained open on its original loopback listener. Ordinary Chrome control still times out, a separate limitation from REA reachability.

The [official Auto Buy/Auto Sell reference](https://docs.proxima.tools/live-settings/auto-buy/) was refreshed: combined Counter/DCA/Limit configuration, independent strategy/session endings and lifecycle controls are documented. The [Generate Activity reference](https://docs.proxima.tools/wallets/generate-activity/) explicitly describes real selected-wallet buy/sell loops and per-wallet progress. These references and the passive page establish visible/documented requirements, not Proxima's undisclosed backend architecture, execution correctness or signing implementation. Bundle's read-only warmup journal/runtime checks are not yet an equivalent executing loop.

## Boundaries and next steps

No UI or protected Claude file edit. No schema/migration, application or hosted database execution, provider/credential/cron change, real wallet unlock/sign/send, strategy run, funded test or deploy. Migration journal remains0136; next0137subject to recheck. Git publication is separate from deployment; Git deployment stays disabled.

Remaining product work includes rendered signed-in recovery checks, pre-sign saved-review recovery, durable reservations/orchestration and finalized accounting, and the warmup execution dependencies recorded in CODEX-WARMUP-EXECUTION-CONTRACT-20261022.md. Full Proxima parity, complete history/holder coverage, marketplace payment/delivery and funded proof remain open. No green focused suite closes those requirements.
