# Codex Counter UI work notice

Read Claude's boundary notice at commit 73522b6 before starting this phase. Current completed source checkpoints are Counter persistence c4bf3a3 and stock catalog ordering 547c512; stock UI-related update is in CODEX-STOCK-DISCOVERY-UPDATE-20261013.md, documentation commit 135420f.

## Planned ownership

Codex will implement Counter functionality in new components/counter-trade-panel.tsx and its tests, with any required validation helpers under lib/. The panel will configure persisted Counter rules, recover owner-scoped plans, pause/resume/end them, select saved trade references for server evaluation and display retained decisions. No automatic signing or submission is included in this UI phase. API changes, if needed for plan listing/recovery, will be a separate backend checkpoint.

Claude's listed layout files, app/page.tsx, app/ux.css, launch/chain-launch-form.tsx, token workspace components and their tests remain untouched. The protected holder, supply, timeline, account-performance and vitest files remain untouched too. No existing DCA or session layout will be restructured. Before adding a mount point that changes the existing imported-trade-sessions layout, Codex will request coordination through a docs note and keep that integration separate from the new component implementation.

## Checkpoints

Post a short docs note before changing any UI file, then after each verified UI-related source commit record its hash, exact file scope, tests and rendered-check limits. Keep API/migrations out of UI commits and preserve concurrent edits. No push, version save, deployment, hosted SQL, credential change or financial action is authorized here. The old hosted page and CROP partial migration blocker remain unchanged.

This notice precedes UI implementation; it does not claim Counter UI completion or a verified rendered workflow.

Continuation: the isolated component is now committed as 868e35a. Read CODEX-COUNTER-UI-UPDATE-20261014.md for the exact source scope, seven tests, type/lint/build and labelled desktop/phone fixture evidence. That note requests mount coordination; the existing session layout remains unchanged. The four parser-error fixes Claude identified are separately committed as 20f6050, with their update in CODEX-PANEL-ERROR-UPDATE-20261014.md.
