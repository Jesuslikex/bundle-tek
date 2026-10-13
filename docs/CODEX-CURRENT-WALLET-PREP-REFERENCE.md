# Current Proxima wallet preparation reference

12 October 2026. This extends the earlier REA investigation. It does not prove full Proxima parity, backend custody or funded execution.

## Current live UI observation

The dedicated REA CDP endpoint at 127.0.0.1:9223 was unreachable from both REA and a Windows read-only endpoint check. No browser/debugging setup was changed. A new temporary tab in the user's existing Chrome profile remained signed into Proxima. Browser extension UI observations below are **CUA evidence**, not live REA capture.

My Wallets displayed chain and folder navigation, wallet balance/volume/P&L columns, Create/Funding/Withdraw/Generate Activity/Manage controls, and an Export action. No keys were revealed or exported. Generate Activity was disabled at zero selection and became enabled after one wallet checkbox was selected. Current client source shows its onGenerateActivity callback only opens a modal. The modal was opened, read and closed without entering values or pressing Start. The checkbox was deselected afterward; the control returned to disabled.

The modal displayed Fixed/Range amount controls, Loop Count, minutes/seconds delay, Alternative Routing, and selected-wallet/Required/Estimated summary fields. It described its purpose as generating fake volume, and described routing as creating an impression of trading-platform usage. These are observed UI descriptions, not evidence of authentic venue execution or backend implementation. Bundle retains its established transparent planning/history workflow and separate per-transaction approval model.

## Current shipped-artifact identity

The current rendered-page asset inventory identified a newer main entry, `index-ZhAV7deG.js`, replacing the earlier captured `index-CawqJF19.js`. The wallet page loaded `page-C9arUq-y.js`. Public files were downloaded from those exact observed asset URLs as inert analysis inputs; no cookies or credentials were supplied or copied.

| File | Bytes | SHA256 | Analysis scope |
| --- | --- | --- | --- |
| index-ZhAV7deG.js | 4925389 | 7440ec24b3045d3b56c0ed1864fb2cb2c9ba310c4b3704b295b0b5c0c2214451 | Retained identity; not semantically analysed in this pass |
| page-C9arUq-y.js | 77529 | de12a133f4376d6cfe5f0c32635281c66bcc04215b9cdbb198234783c2e5c82f | Complete static inventory/parse of this wallet-page artifact |

REA analysis parent: `ev_8596e144015486471cae3e036847b01069e1ebd3684067a128fea764c2d4b452`.

Summary view: `ev_fb89c70c894a6576d8604f7bb8b6eb826824ba0369df60f5cd6626a630e11b6c`.

Exact wallet-page asset item: `ev_8a2e2521d8ff327580cc312883f93bffac0613a5c9e197cad641d81ad6ad3204`, node `jag_node_0c44c9dae15de1a99c1b8d0d78c57a0fa7d168279b34882fb374ab0570fe2ec5`.

The analysis parsed one file with 22014 visited AST nodes and 132 findings. Application coverage is complete within that file, with no omitted semantic nodes/relations. Semantic status remains **unknown**, with 4642 unresolved semantic observations and dependencies outside this one-file input. Source callback readings are hash-linked client constructions, not proof of runtime backend calls. The main entry and the rest of the platform are outside this analysis scope.

The retained evidence bundle is `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261012\rea-evidence.json`. Export reports four records. Its top-level unknown-record count is not a claim that semantic unknowns disappeared. The copied input and public source files are in the same directory.

## Bundle implementation

WarmupPlanSummary now appears after a plan is reviewed and before saving a draft. It renders selected wallets, planned actions, cycles, exact per-wallet and total budgets, user-chosen reserve, and first-buy/last-sell targets. The elapsed window is computed from the actual sorted action schedule, including wallet staggering and the sell delay. It does not multiply elapsed time by wallet count, estimate provider fees or promise execution at those times. Existing history checks, quote/preparation/signing routes and wallet encryption remain unchanged.

Tests cover subunit ETH budget precision, multiple-wallet staggering and the single-cycle buy-to-sell interval. Six summary/planner tests, TypeScript, scoped lint and the production build passed. The React checklist found no added data-fetching effects, shared mutable state or expensive work; the summary uses semantic definition lists and time elements with scoped responsive CSS. Current rendered desktop/mobile verification of the Bundle component remains outstanding because the previous local browser-access restriction is not bypassed. No new deployment was attempted; hosted version 115 remains blocked by the migration error.

## Full captured main-bundle parsing and semantic limits

The captured `index-ZhAV7deG.js` was copied byte-for-byte into `main-input`, with original SHA256 `7440ec24b3045d3b56c0ed1864fb2cb2c9ba310c4b3704b295b0b5c0c2214451`. REA directly analysed all 4,925,389 bytes as inert source with 2,048 MiB and then 4,096 MiB heap limits, each with a 300,000 ms per-source deadline. Both retained results report one parsed file, zero parse failures, 949,317 visited AST nodes and 602 findings. The exact asset item reports `text_status=included` and `parse_status=complete`. This is full-file syntax coverage for this captured artifact, not current network execution.

Both workers exhausted their heaps during semantic analysis. Application coverage remains partial with unknown omitted count; semantic coverage is partial/truncated with unknown omitted node/relation counts. Each of the twelve semantic families retains zero relations and an explicit unknown. The inspected module collection has 145 entries, including unresolved reference roles and the asset; it must not be described as 145 recovered bundled modules. The statistics report zero recovered factory modules. A reference item inspected during this pass was an unresolved UpdateAccount CSS dependency, not evidence of account execution.

Evidence: 2 GiB parent `ev_ccfb305b03e29f6af2d4e749b3d80074883956f1c4c27eaf0f12be621f1a0b3b`; 4 GiB parent `ev_d0a1b606647b213ff080fd11b0f7d6154b4e06fa33991556213ca8aeb973cfd8`; exact asset item `ev_b261fa8d71d177b0ebba66fe773f7292eea507d5e10c17bbce810313588c3e86`. Complete retained records were exported to `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261012\main-analysis-full-session-evidence.json` (12 records, 34,261,288 bytes). The export's zero top-level unknown-record count does not override the semantic coverage unknowns above.

The supported `recover_javascript_sources` inspection/minimal request returned `capability_unavailable`: the connection lacks an absolute `REA_WAKARU_COMMAND` for its caller-supplied Wakaru engine. No application code executed, engine installation/configuration change, additional network capture or Bundle application edit occurred during this investigation. Increasing the heap twice did not establish semantic coverage; do not repeat an identical resource-limited analysis or claim complete REA understanding. Region recovery needs the missing engine, and current live capture still needs the user to reopen the previously approved dedicated CDP browser. Backend custody, signing, automation and complete route dependencies remain unknown.

## Recovery engine and complete inspection-region extraction

Subsequently, the documented official Wakaru 1.14.0 Linux binary was installed at `/opt/rea/tools/wakaru-1.14.0/wakaru` under the dedicated `rea` WSL user. Its binary SHA256 matches `664fa06782a61eda7ed15885134b52525fd565dd77607e642062ceb6cd927c38`, and its version command returns 1.14.0. Existing REA CLI version 6.4.0 and `/usr/bin/prlimit` were verified; Node, Java, Ghidra, default launcher and Codex MCP settings were preserved. A separate Desktop REA `rea-recovery.cmd` supplies the engine variable per CLI invocation. The existing MCP process has not been reconfigured to inherit that variable.

The first Windows-mounted recovery output failed REA's required fchmod operation. Recovery succeeded instead in the owned Linux directory `/opt/rea/results/proxima-main-inspection-recovery-20261012`, without disabling authority guards. REA returned recovery Evidence `ev_52ef38862fcc933e39b9d8d88d8dcce4420491d0a042ed8381e7b85bf7f894b8`, status complete, scope-hoisted format, 931 inspection regions, zero failed transformations and no warnings. Source identity is the same original main-bundle digest. The manifest digest is `626b7feec083f63b41dc7c960e92c63b484b7924997e6d0d43233a6e80157deb`. Canonical CLI output is retained at `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261012\main-recovery-linux-cli.json`.

Derived JavaScript totals 9,101,250 bytes. The largest region, entry.js, is 2,358,334 bytes. The arithmetic union of reported half-open original byte ranges is 4,925,387 of 4,925,389 bytes. These counts establish reported extraction ranges only; they do not prove whole-bundle semantics, independently correct source-map mappings, original module boundaries or runtime equivalence. REA explicitly marks runtime equivalence unknown and executed engine source revision null despite the pinned release-binary hash.

The complete returned `analysis_input` directory, `/opt/rea/results/proxima-main-inspection-recovery-20261012/modules`, was analysed through REA with a 2 GiB per-source heap and 300,000 ms per-source deadline. Functions execution cell 469 completed. Source recovery alone does not close the full-goal REA, current-runtime or backend requirements.

## Terminal derived analysis and wallet/activity group

Complete derived-directory analysis parent Evidence: `ev_7c23ea7b883e207799fba0df752e4722a179023cd1e24dcde737c2c36ebc5c5b`. It parsed all 931 JavaScript files and 931 source maps as relevant files, read 13,477,588 text bytes, visited 1,023,034 AST nodes and retained 5,553 findings with zero parse failures. Coverage remains partial: the cumulative parent result budget caused semantic work for many later files not to start, and entry.js exhausted its worker heap. Retained relationships include 19,322 data-flow, 686 call-flow and 2,162 closure relationships; 1,751 application unknowns and 18,254 semantic unknowns remain. The canonical session was exported to `/opt/rea/results/proxima-derived-analysis-evidence-20261012.json` (113,409,985 bytes). Export unknown-record counts are not semantic completeness.

To answer specific controller questions, thirteen recovered wallet/activity files and thirteen maps were copied byte-for-byte into `/opt/rea/results/proxima-wallet-activity-regions-20261012`. Each copied file/map digest and byte length was checked against recovery Evidence. The sibling provenance manifest is `/opt/rea/results/proxima-wallet-activity-regions-provenance-20261012.json`. The group includes wallet creation/import, wallet-runner updates, launch query helpers and history helpers. `chunk_generateMutation.js` proved to be SVG replacement support, not trading activity; its name must not support a wallet-generation finding.

Group analysis parent Evidence: `ev_fea134d22c01762b767bce8b6ef06d6d1b7620cd40178ed3065c9a7cf6287dd1`. All thirteen JavaScript files parsed, with 21,594 visited AST nodes and 356 findings. Application coverage reports complete within this selected input; semantic omitted nodes and relations are zero. Semantic status remains unknown, with 5,002 explicit semantic unknowns despite 19,192 retained relationships. Vendor dependencies, entry.js and the backend are not included/resolved by this group. This group is targeted evidence, not a smaller definition of whole-app success.

`trace_javascript_semantics` for the observed `addWallets` property returned Evidence `ev_aea019f9458f41ce970562626dc33ec7a4bac607191d7f6b35ed44ccfc22807b`: one match, partial coverage, unresolved `/wallets/addWallets` receiver at recovered useLaunchInfo line 320. Recovered source shows a mutation callback supplying chain, count and tag IDs; the trace does not establish the service implementation or custody. Separately, the history helper's syntax requests paginated history, and its launch variant declares a 2-second refetch interval; this is not observed live polling. The wallet-runner helper preserves mode/end-condition/options and proposes combined existing/new public keys, then calls buy/sell runner modifications. This is static client behavior, not a proven backend executor.

No Proxima application code executed, private credentials were inspected, user transactions were signed/submitted or Bundle application files changed in this investigation. Current live CDP remains closed pending the earlier user request; backend signing/custody, runtime equivalence and the full product goal remain unverified.

## Reopened live session supersedes the closed-browser status

The user reopened the approved browser, and REA live navigation, passive JSON shapes and an eight-second precise execution capture completed. The current main-script hash matches the recovered artifact. See CODEX-PROXIMA-LIVE-REOPENED-20261012.md for exact evidence and limits. This supersedes the closed-CDP status above; the static-only no-execution statement describes the preceding investigation. Backend custody/signing/execution remain unknown.
