# Continue recorded warmup activity

20 October2026. Source follow-up tof6ada0a. This adds navigation to the existing manual flow, not automatic execution.

The recorded-progress view now offers one compact review shortcut before the per-wallet summaries, accounting and paged table. It chooses an active approval first, otherwise the first remaining recorded buy lot, otherwise the first unbought cycle. Selection uses the complete already-admitted step vector, independent of the visible table page. This ordering is a UI suggestion, not schedule/due-time admission or a change to the existing table actions.

Recovery calls the existing owner-wallet recovery callback. A sell/buy shortcut passes the exact original step object to the existing review callback, which retains its plan/cycle/wallet/mint/recovery validation. That callback opens and focuses the existing unsigned preparation view. No amount or finalized lot is auto-selected, no packet is prepared and no signature/send approval is granted. Historical-revision opt-in, matched-lot selection, separate signing/send approvals and finalized receipt recovery stay unchanged.

The card distinguishes an unbought step in the selected revision scope from the absence of all historical buys. Completed included lots do not imply profit, current balances or readiness. An active approval without a matching recovery row does not produce a replacement-trade shortcut. Read-only contexts have no new transaction action; the parent's existing archived/selection guidance remains. No new fetch, timer, persistence, scheduler or backend path is added.

## Verification

Final12 related files pass together, **151 tests**, including six new card tests and16 manual-workflow cases. The card tests cover explicit-only callback invocation, exact original step forwarding, remaining-lot priority, recovery priority, active-approval/no-row refusal, read-only state and receipt-scoped completion copy. Existing model/activity/session view/retention/storage/read-panel regressions remain green. Workflow integration verifies focused buy navigation without a preparation POST/unlock/sign call, plus recovery/cancellation refreshing the shortcut. Plain TypeScript, four-file typed lint and formatting pass.

Chrome renders the actual workflow/card with production CSS and public synthetic metadata, using a provider-denying fixture and vault-unlock refusal. Desktop1440 has equal document/client widths1440. Review next buy focuses Selected warmup transaction review and leaves all existing approval steps untouched. Phone375x812 has document/client widths360/360, card326 and recovery action44px high. The recovery fixture shows approval recovery instead of a trade shortcut, and its existing history view opens with the unknown-outcome warning. The first browser recovery click did not visibly change state; after inspecting the enabled control and empty error log, one retry opened the recovery panel. No application error was observed or inferred from that first unchanged UI action. Screenshots: `docs/qa/20261020/warmup-next-review/`.

Final isolated Next production build exits0 onf6ada0a plus five exact source/test/CSS overlays, all canonical/snapshot hashes unchanged. Evidence: `CODEX-WARMUP-NEXT-REVIEW-BUILD-20261020.json`. Sanitized environment/no application secret file, dependency junction and local fonts. No full repository suite, real sign-in/provider qualification or funded proof is claimed. The synthetic workflow tests use deliberately invalid packet/signature markers, never real wallet material.

The retained Proxima Generate Activity/session controls remain reference evidence rather than new live REA coverage; the last approved9223 refresh was unreachable. Claude Opus5.5 review is requested against the committed checkpoint and is not implied by this verification.

Only Codex-owned workflow navigation/UI/tests/notes changed. No protected shell/token layout, manual signing/submission implementation, migration, application/hosted SQL, provider/credential/cron or deployment. Automatic warmup Start, durable execution authorization, scheduler and alternative routing remain unfinished. Broader Proxima parity remains incomplete.

## Accepted Opus5.5 wording review

Claude reviewed pushed3dd7940 read-only in the existing Bundle project on Opus5.5. It reported no correctness/safety issue and one valid low-severity wording issue: the no-onReview message asked for selected wallets even when the parent had disabled review for an archived or non-Solana plan. Codex confirmed it against the existing parent guard rather than treating the suggestion as authority.

The card now uses the already-admitted progress.archived value for explicit restore guidance, retaining approval recovery; other read-only contexts state the active Solana plan/selected-wallet prerequisites. No callback, admission, approval or execution predicate changed. The new archived regression verifies no trade action plus continued recovery. Final23 card/workflow tests pass (7+16), typed lint/format pass. The earlier151-test related run remains the broader checkpoint evidence; overlapping counts are not added as separate tests.

Actual Chrome375 archived workflow shows restore guidance, zero shortcut buttons and equal client/document widths375. The parent still shows its original restore/recovery message. Screenshot `phone-archived.jpg` is added beside the earlier screenshots. Final isolated production build exits0 on3dd7940 plus the two exact source/test overlays, with canonical/snapshot hashes unchanged: `CODEX-WARMUP-NEXT-REVIEW-FINAL-BUILD-20261020.json`. This supersedes the original build only for the accepted wording/test follow-up.

Claude checked the card priority/vector forwarding, parent review guards/focus/refresh, recorded-scope copy and unchanged financial/storage file boundary. It ran no tests/typecheck/lint/build and did not inspect QA pixels or build evidence. Codex owns those verifications; no broader live/backend or funded proof is claimed. Claude also acknowledged the source-only/no-release boundary. No protected file, provider/configuration, hosted SQL, real wallet action or deployment changed.
