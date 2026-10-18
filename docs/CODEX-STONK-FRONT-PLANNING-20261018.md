# StonkFun Front planning and encrypted mint candidate

18 October 2026. Separate planning-only workflow; StonkFun transaction execution remains unavailable.

## Evidence and implementation

The approved CDP endpoint still lists Proxima at /account (target FD4F2507C26F7CA04B1FD4F7065A387D). This chat did not navigate it while the other chat uses the account reference. The REA server's current ledger no longer contains the historical Stonk records; a summary lookup returned zero matching records, so no repeated capture is claimed.

The complete historical export Desktop/REA/results/proxima-recheck-20261014-0211-evidence.json was reread locally. SHA256 1e8d18a0e4b5e863cb4b066a788ad0d6d067a31c56c4dc445f260e2362141165. Its records ev_3b735b08c93ceb74c7dbdb37a5b7572b208881a1a541bf293d0da642c2f5bd60 and ev_5c66fce496ceba9e0a3d90979939ab81a8839a5ec0ac525e34c0d2ab16827fce show selected StonkFun, fee modes and the xStock picker. They do not establish mint custody, backend execution or today's behavior. Existing primary-doc cross-check and the model's Front-only/12 limit are documented in CODEX-PROXIMA-MEV-FUNDING-FIELD-MAP-20261018.md. Bundle's browser-encrypted candidate workflow is its own implementation, not a claim to have recovered Proxima's private-key architecture.

The metadata review now mounts a separate StonkFun Front planner only for a saved Solana StonkFun Block-0 project. It does not route StonkFun through Pump's financial handler. Users can generate a project-bound encrypted mint candidate with the existing eight-character minimum and vault implementation, or restore this project's encrypted backup header without decrypting it. Existing saved candidates load without generating/replacing keys. Explicit encrypted backup download is available. Public header restoration does not prove key control; the UI says so.

Generation/restoration has a synchronous in-flight guard, clears the password before asynchronous work and refuses publication after component disposal or project revision changes. The existing locked storage helper prevents replacing another candidate. Oversized and foreign backups refuse. Metadata publication busy state disables candidate/planning controls. No key generation, download, decryption or signing runs automatically.

The shared lazy entry and inner planner use Front-only wording. The new Stonk entry refuses a loaded saved Pump context, so an unsaved venue switch cannot silently plan against the wrong saved platform. Existing owned service checks, wallet uniqueness, exact revisions, Stonk maximum12 Front/noBack/noTemporary, ceilings, fees, native comparison and planning-only authority flags remain unchanged. Pump's default labels/behavior remain. No protected shell or token layout changes.

## Verification

Final offline run: 10 files / 133 tests passed together, zero failed/pending/todo. Evidence prefix work/release-qa/stonk-entry-venue-20261018. It includes seven new candidate lifecycle tests, metadata entry/no-project checks, shared real dynamic planner labels, actual API/database saved Stonk admission and saved Pump refusal, existing Pump review regressions, layer client/terms and real mint-vault encryption tests. The initial seven new tests failed because fake timers advanced before React committed the effect; the corrected test helper advances them after the commit. Initial failure and subsequent corrected/final evidence remain separate. Existing planner-history act warnings remain reported; they are not silently fixed here.

Eight-file type-aware lint, formatting and current project TypeScript pass. The browser fixture bundle builds. No new full-suite green result or Next production build is claimed.

Chrome rendered the actual Stonk component/shared planner using current theme CSS and a synthetic public mint with invalid ciphertext. Opening the planner worked; desktop1440/1440, phone375/375 and narrow320/320 client/scroll widths had no sideways overflow. The first rendering revealed the inherited Front/Back heading; it was corrected and regression-tested, then the final source was rebuilt and recaptured. Final screenshot work/stonk-entry-qa-20261018/final-mobile.png, plus desktop/mobile/narrow evidence and fixture source. Fixture writes/provider reads and crypto decrypt/sign are blocked. Generation/restoration lifecycle is tested with controlled helpers; browser checks did not create, unlock or sign a real wallet. Tabs/server were stopped and viewport reset.

## Remaining work and boundaries

StonkFun creation adapter, verified current program/platform/configuration and decoded unsigned packet, simulation, approved signing/broadcast, receipt recovery and funded proof remain absent. Stock runtime signing remains off. Imported-token planning still needs its own client selection/context and owned target/revision entry; staged funding and execution remain unfinished. This improves reachability and candidate preparation, not complete Proxima parity or live launch readiness.

The other Bundle chat's account receipt/schema/migration drafts were preserved. No push, deployment, hosted SQL, provider/credential/cron change, funded trade or real signing occurred.
