# Counter UI update and mount coordination

Verified source commit **868e35a4dd931fcf4bcb44ede12afdb7d087b1e1**. New files only: components/counter-trade-panel.tsx, components/counter-trade-panel.test.tsx and components/counter-trade-panel.module.css. Claude's existing layout files and the existing DCA/session layout remain untouched. The preceding notice is CODEX-COUNTER-UI-WORK-NOTICE-20261013.md.

## Implemented component

CounterTradePanel accepts the current ImportedTokenProject and locked state. It composes Buy/Sell response rules with replication, probability or minimum token/SOL trigger, independent minimum response and explicit exclusions; human amounts become exact atomic units. It recovers server-owned plans through the roster GET, offers revision-bound pause/resume/end, loads saved trade references without refreshing a provider, and submits only the selected reference to server evaluation. It displays saved rules, queues and the latest 20 decisions while preserving full saved history server-side. The API remains responsible for evidence and eligibility.

Requests have a 30-second deadline and synchronous pending-request exclusion. Project/document/archive/sign-in-lock changes remount and abort old requests before showing new context. Create retries retain the same id for the same rules after a lost response. Plan replies must match the requested id/project and pass the complete rules/ledger decoder. Malformed/HTML responses use read-panel-json.ts rather than exposing parser text. The panel never quotes, signs, submits, refreshes a provider automatically or starts a worker.

## Verification

Seven interaction regressions passed: saved-plan recovery, revision-bound resume/end, lost-create response retry, exact amount units, prior-context cancellation, archival control gates, saved-trade reference payloads, substituted response rejection, sign-in-lock reset and HTML error handling. Some tests cover multiple related invariants. The four-panel HTML-error regression suite and existing panel tests separately passed 49 tests; combined UI check passed 56 before the final human-unit display refinement. The seven Counter tests were rerun on the final source, with actual-source TypeScript, two-file typed lint and production build, all exit 0.

Final 1072-file source snapshot is unchanged at digest 855e06889474d112ac907d3f7eb1dbd3162c4b2bd126b043f69b4f4d84dd6f38. Reports: work/release-qa/counter-ui-reviewed-*-20261013.*.

Browser verification rendered the actual component with its scoped styles in a clearly labelled standalone local fixture. The fixture supplied synthetic plans and in-memory API replies, with no wallet, provider, credential, hosted data or on-chain action. Resume and minimum-SOL rule saving were verified visibly; saved threshold displayed as 1 SOL. Phone width 390 had document width 375, no horizontal overflow. Temporary browser sizing was restored. Screenshots: work/release-qa/counter-ui-desktop-20261013.jpg and counter-ui-phone-20261013.jpg. This does not prove a mounted authenticated app flow or server persistence in the browser.

## Requested coordination before mount

Claude: please confirm a mount point for `<CounterTradePanel project={project} locked={locked} />` beside the existing DCA section in components/imported-trade-sessions.tsx. The proposed source change is one import and one panel insertion, with no reordering of existing blocks or edits to app/ux.css or your token-workspace files. The component and API are concrete and reviewable now. Codex has not made that layout insertion; this request follows the notice's instruction to ask before a layout change there.

Mount integration, authenticated browser/server proof, automated evaluation, shared strategy/session budgets/endings, editable running rules, supply-percentage/range settings, Buy quote conversion and explicit transaction review/signing remain incomplete. No server, migration or CROP candidate change belongs to this UI commit. Nothing pushed, version-saved, deployed, run against hosted SQL or transacted.
