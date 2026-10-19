# UI commits and continuing release QA

## Committed UI changes

- `8af171d`: appended only the allowed table-wrapper positioning rule in `app/ux.css`. The authenticated local candidate fits at320/375/1440; four existing dashboard tests and an isolated production build pass. Root source and DOM inspection identified the hidden Actions header as the overflow cause. Claude-owned component markup is unchanged.
- `c2a585d`: Codex-owned `pump-layer-planner.tsx` and its test reveal/focus a successfully saved snapshot. Eleven files/116 tests, typed lint, formatting and an isolated production build including TypeScript pass. See `CODEX-LAYER-SAVE-REVIEW-20261019.md`. Browser checks of that new disclosure behavior remain pending.

The frozen full-suite process still runs against `4b4363b`. At01:23:44UTC it reported113/613 completed files and zero failed files. This is progress, not a pass. Its eventual result and source-hash checks must be retained before release qualification. Delta test/build results above are separate from that baseline.

## Actual signed-in candidate checks

The isolated production app uses real Better Auth, actual Next API handlers and all117 unchanged migrations in disposable local SQLite served through a local libSQL-compatible transport. It has no real provider credentials. Its synthetic provider supports receipt reads only; financial writes are blocked. The account, wallet addresses, launch receipts and sale are synthetic fixtures. These checks establish browser/API/data composition, not funded execution or real provider qualification.

Finalized sale evidence was captured through the app. Assigning999 of1000 raw units was rejected. The complete1000-unit review began unchecked with save disabled; approval enabled save, and editing the units cleared consent. A new exact review saved once. After reopening the app, navigating back to the sale loaded the exact retained allocation and hash without another save.

Token artwork rejected an undecodable PNG fixture. A valid browser-generated PNG uploaded successfully and appeared as selected private artwork, with the instruction to save the project to retain the selection. An unauthenticated request for that private artwork returned401. No production artwork was uploaded or token created.

Sanitized screenshots and width measurements are in `docs/qa/20261019/release/`. No user production account data is included.

## Fresh Proxima observations and remaining comparison

The approved second Chrome window was running and reachable from Windows at loopback9223. REA inside WSL could not reach Windows loopback directly. Restoring the previously approved local-only stdio relay reconnected the existing browser without relaunching Chrome, copying cookies or changing credentials. REA target evidence: `ev_c96b27779305ad4ab81a45b612e1e56a622473ed32395c5a9c70203366aa71b8`; fresh passive account capture: `ev_672c7f483f4ccda4d171158b18305ce962f025147ebbad478b59c0c03f551992`. The sanitized capture summary omits account values. Passive capture does not prove historical network behavior or backend execution.

Separate ordinary Chrome UI inspection on19October found seven chain choices including X Layer/ignix. Proxima reports Robinhood16 and BNB4 launchpads; Bundle's checked build has six chains, Robinhood15 and BNB3 profiles. These are catalog/UI gaps pending exact venue and protocol validation, not reasons to claim unsupported execution.

With PumpFun selected, Proxima visibly offers SOL/USDC/Custom launch currencies, Creator/Holders rewards, Creator Fee Distribution, and new otcdesks, UsePaid and Ansem Launch controls. Its Advanced disclosure shows Mayhem Mode and Off-Chain Create with explanatory text. Only the selection and Advanced disclosure were opened; no option was enabled, saved or funded. No signed payload, API contract or backend provider relationship is established by these observations. Compare current Bundle source before implementing each gap; keep all unavailable execution explicit and signing safeguards intact.

Actual Claude review used `claude-opus-5-5`, read-only with tools disabled, and reported that its scope was pasted source rather than live Proxima. The successful save reveal was adopted after independent source review and tests. Other findings remain listed in the save-review note. Full Proxima parity remains incomplete.

No deploy, hosted SQL, provider/credential/cron change, real wallet unlock, signing or funded trade. Git-triggered Vercel deployment remains disabled. Production still requires the separately approved nine-migration release step; this QA does not apply those migrations.
