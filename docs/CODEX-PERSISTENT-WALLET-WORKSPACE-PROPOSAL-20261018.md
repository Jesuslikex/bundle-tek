# Persistent chart and wallet workspace proposal

18 October 2026. Proposal against application source `84a9b03`. The original full offline suite has terminated with its source and harness unchanged; the other Bundle chat is correcting baseline test-runner/checksum issues before revalidation. Application source and the local helper remain held. The UI changes are not integrated or live. An exact unapplied patch is retained at `docs/patches/CODEX-PERSISTENT-WALLET-WORKSPACE-20261018.patch`; working copies remain in ignored `work/persistent-workspace`.

## Reference and requirement

REA captured the existing launched-token workspace at `2026-10-18T06:40:31.455Z`, viewport 1920×945. Evidence `ev_078efd701a7fff4508a75e7d044c6edaf987fa423a1c766816c537d3166d7a66`, PNG SHA256 `03fd3f9af07a498982a4f8ce81fac610cec49b58c3bd1ad7b1803dd5fa03f514`, 277477 bytes. The image is retained in REA evidence; this note does not claim a separate local PNG export.

The reference shows token stats above a chart and tape, a trading column at right, and a wallet navigation/table below the chart, all within the same desktop viewport. Navigation includes wallets, latest trades, holders, history and bubble maps. This is visible layout evidence, not proof of backend architecture, trading execution, wallet custody or P&L methodology. No financial control was activated. The original account page was restored after observation, evidence `ev_d325ad9e92522f09d58110e383dc7da3895da4344c7f7340cef40ff1c59272d1`.

Bundle's accepted layout checkpoint brings the start of wallet controls upward but still requires scrolling to reach its table. The next requirement is a complete chart and usable wallet row together where the available desktop space permits, with every action reachable and ordinary flow on smaller screens. Do not claim parity from a dock class, screenshots of isolated fragments or a clipped plot.

## Prepared files and ownership

- Protected file proposal: `work/persistent-workspace/owner-proposal.patch`, targeting only `components/imported-token-projects.tsx`. It moves the unchanged picker into the selected-token header, groups unchanged project actions, wraps the existing market/trade composition, and adds mounted lower-view panels. Existing callbacks, project/revision guards and desk reset keys remain.
- New owned files: `imported-workspace-frame.tsx` and its CSS module. They measure actual room beneath the header and the complete chart plot. Docking requires a wide/tall desktop and room for the plot plus wallet row; otherwise use normal flow. Expanded header/plot content is remeasured. No provider, storage or financial action is added.
- Owned wallet proposals: `imported-swap-wallet.tsx` and `imported-trade-wallets.tsx`. The table comes before the longer selected-wallet review; filters and detailed inventory explanations remain in a disclosure. Errors/stale-inventory warnings remain outside it. Successful existing wallet-review actions reveal the wallet view and selected-wallet review; the existing validation runs first.
- Compact lower views: My wallets, Supply and alerts, Solana Holders, and Activity. Switching views leaves their components mounted, preserving existing review and monitor lifetimes. A visible note states that reviews and monitors stay active. Full-page review shows all panels and does not add needless region Tab stops.

No canonical file listed above has been edited. No app/page.tsx, quote/signing component, API, provider, dependency, credential or migration change is proposed.

The combined six-file review patch is 50907 bytes, SHA256 `e00a0fbf21e64b1c515928558bd2bc2006847f8c8c642a6bd2a62e6c40f26b7b`. It includes the protected composition, two owned wallet files, new frame/CSS and a prepared test file. Tests cover mounted state/timers, keyboard tabs, successful cross-panel navigation and measured fit/scroll fallback. Those tests have only been syntax-parsed, not executed. The patch has not been applied.

## Claude owner review

The original UI author session `8b2f1c6d-350a-4f9f-9f09-895f216a207b`, pinned Opus 5.5 with tools disabled, read the exact first protected-file patch and the support component/CSS. It conditionally approved application after the freeze and after table-first adjustment plus full-shell rendering. This was a source review, not an independent test/render run.

Its required focus fix is applied in the ignored proposal: only tabbed panels have `tabIndex=0`. The receipt-handoff behavior is explicit: reviewing a receipt remounts the already keyed swap desk and returns to My wallets, where the selected-wallet review is open. The new lower-view component does not extend that pre-existing remount boundary.

Claude also called out hidden monitor announcements, the assumption that `.workspace` owns scrolling, narrow-desktop tape stacking and mutation-observer frequency. The proposal now visibly explains continuing monitors; alert badges remain a later improvement. The later Codex-owned wallet/context follow-up still needs verification; this note does not extend Claude's initial review into a blanket approval of all future changes.

## Evidence and acceptance still required

Ignored copies pass Oxfmt formatting and TypeScript syntax parsing. A static AST comparison finds identical multisets of 36 existing JSX disabled/value/checked/required/aria-pressed expressions and eight direct fetch calls across the protected composition and two owned wallet files. This is limited structural evidence, not typechecking, authorization equivalence or behavioral proof. Reports: `proposal-static-check.json` and `safeguard-audit.json` in the proposal folder.

After the suite owner releases the freeze:

1. Rebase the exact proposal onto the actual current source, inspect intervening changes and announce owned paths before applying. Preserve the original full-suite evidence and do not mix its failures with new layout results.
2. Verify tab keyboard/focus behavior, hidden-panel state retention and full-page mode. Exercise successful/refused cross-panel wallet review, handoff visibility, context changes, cancellation and existing expiry/approval guards.
3. Render the current full client shell at 1920×945, 1920×900, 1440×900, 1360px, constrained desktop and 375/320px. Measure the full plot, first actual wallet row, table actions, active/frozen/error states and internal scrolling. If docking cannot fit the complete plot and useful wallet content, refine the layout or fall back; never shrink the plot or hide warnings to manufacture a pass.
4. Check expanded picker/actions/help, actual workspace versus body scrolling, trade tape access, responsive overflow and observer stability. Complete relevant tests, plain TypeScript, scoped lint, CSS-module build and rendered checks before integration/commit.

No runtime tests, application build, provider read, funded test, push, deployment or hosted SQL ran for this proposal. No passing full-suite outcome or complete Proxima parity is claimed. The suite owner released the index for this explicit documentation-only checkpoint; its source/config/checksum changes and full-suite report are excluded.
