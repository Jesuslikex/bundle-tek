# Volume Bundle reference and execution-mode clarity

Own scope: Volume panel, its CSS/test and this note. Started after `08bc17f` with the other chat's untracked launch-layer foundation preserved; its `a07bbe9` commit and subsequent exchange API work are separate. No model, packet, transport, signing, schema or provider behavior is changed by this checkpoint.

## REA findings

Windows' existing debug browser answered HTTP 200, but REA's WSL endpoint was unreachable. Restarted only the existing stdio/loopback relay, session 14985. Fresh discovery and passive funding observation succeeded. Navigated read-only to an already-observed live launch URL. Evidence `ev_cbba6e03caf533420d8be21a9e8e0062070466218b957569cdeeed2a43812f23` showed Volume Bot, Configure and no active Volume Bot session.

Interactive Configure scenarios stalled, including an attempted keyboard action with a timeout. Their orchestration cells were stopped; no completed Configure result or opened form was observed. A restore scenario also stalled. Separate installed CLI attempts failed with execution/input errors. No runner, wallet selection, funding, buy/sell or other financial button was activated. The last successful target discovery `ev_3cd7c6be557bc03fe2b50384717260f42ddeca55b6a5dea682a0ba18d9d933ee` still showed the read-only live launch page rather than the original funding page. Do not claim successful interactive configuration inspection or restoration.

Fresh passive script-source capture completed with evidence `ev_f5eae21547f965626cbd47370df1e15b0e23caa0df80e45b5fec9902287fb2ea`. Its complete response exceeded MCP's transport budget, so retained evidence was exported once to `/opt/rea/results/proxima-volume-bundle-20261018-current-evidence.json` (six records, 16,576,088 bytes). The private export is outside Git. It includes the currently loaded `https://app.proxima.tools/assets/useLiveWalletFeatureRuns-Cn5GT7jH.js`, SHA256 `133e04fe068cd9aea376d16fd61c036983245a3bf268def2003ad78acc998246`.

Bounded, non-executing inspection of that captured script confirms:

- Bundle mode's displayed definition is one wallet buying and selling in the same block.
- Organic mode's displayed definition spreads trades with delays.
- The Bundle button can be disabled when a chain has no bundle relay, with explanatory title/text.
- Fee Target is optional and described as a total tip budget for the session.

These are current delivered-client definitions, not observed execution, relay guarantees, tip allocation/refund rules, atomicity proof or full backend semantics. They corroborate the historical exact-slice analysis in CODEX-VOLUME-WAVE-20261018.md; the current artifact has a different digest. No third-party source was copied into Bundle. Passive captures are origin-filtered and attach-limited. Headers, bodies, cookies and storage values were not requested. A zero unknown-record export count does not close the stated unknowns.

## Bundle correction

The existing implementation deliberately sells after a finalized buy in a later reviewed batch. Batches group approval, with individual configured-RPC sends. They do not implement Proxima's defined Bundle mode. The old generic Proxima comparison and approximate blockhash-window introduction could blur that difference.

The panel now labels Mode: Scheduled swaps, explains individual sends and the lack of a same-block guarantee, and retains the sell-lot rule. Collapsed Bundle mode and tips details disclose that same-block buy/sell bundling and a total session tip budget are unavailable. Wave intensity changes the schedule rather than delivery. The estimate repeats the execution mode. No unsupported mode selector or tip input is added, and no planner or session payload changes.

## Verification

- 57 tests passed across panel, planner, service and batch files. The existing exact estimate/create payload assertions and legacy schedule tests remain intact. The panel test verifies the disclosure starts closed, mode is shown in the estimate and opening the panel adds no mutation call.
- Plain TypeScript and typed lint of both owned TSX files passed. Three-file formatting and scoped diff checks passed.
- Mounted the actual panel and production styles in the existing isolated Volume fixture. It refuses non-fixture fetches and all writes. Verified mode/disclosure at 320/375px, keyboard collapse at 1440px and the estimate's Scheduled swaps label. No horizontal overflow: client/scroll 305/305, 360/360 and 1425/1425. Screenshot `work/release-qa/volume-bundle-mode-375-20261018.png` is labelled synthetic. Reset the viewport and closed the fixture tab. The real signed-in tab and its saved draft were not used or modified for Volume testing.
- Initial shared build 51134 compiled but failed on a concurrent exchange-route test's optional-header TypeScript type. Its owner fixed that file and refroze source/tests.
- Final shared production build 45636 passed, including the other chat's frozen exchange source/tests. Log: `work/release-qa/volume-bundle-mode-build-final-20261018.log`. Those exchange files are not owned by this commit. Source freeze released to that owner after completion.
- Restarted guarded local HTTPS using the normal launcher (PID 29060). Auth health returned 200; the empty submit-action probe remained blocked with 403 before forwarding.

Same-block Volume Bundle execution and total session tip accounting remain open engineering work. This checkpoint improves accurate setup/review and does not implement those features. No funding, preparation, vault unlock, signature, transaction submission, runner activation, migration, push or deployment occurred.
