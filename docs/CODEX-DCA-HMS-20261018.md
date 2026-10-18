# Readable DCA timing with unchanged integer terms

## Change and reference

Retained REA forms ev_bc007f671029d3a5653eb2cd19e66149691fb56b6acb3a20e8c493f17989e371 and ev_5e2f23d15920096f6dc8db94c6aa5404f5f4a06e75ebfd8d3919f763926b3849 show separate hours/minutes/seconds for Proxima DCA intervals and duration. See CODEX-PROXIMA-STRATEGY-COVERAGE-20261018.md for the private retained evidence and observation limits. No new vendor runtime claim is made by this component change.

Bundle now has controlled HMS inputs for time between cycles and duration from scheduled start. Every unit is labelled and the exact total seconds are visible. The shared pure parser uses BigInt, accepts blank individual units as0, keeps all-blank unspecified, and rejects fractions, exponent/whitespace/negative input, minutes/seconds above59 and unsafe totals. It never silently carries overflowing units. Interval bounds remain1to86400seconds inclusive; duration remains a positive safe integer before the original model's date/deadline checks.

The parent stores raw units, derives the original canonical integer strings, and passes the same intervalSeconds/durationSeconds to dcaTradeSessionInput. The persisted request still has schedule.spacingSeconds and a resolved immutable UTC endsAt, with no new time-unit fields. Calendar/deadline switching clears hidden duration units. Raw unit changes participate in draft identity, even when they represent the same total, so prior saved status is not shown for a changed draft. Start time/local timezone, pause behavior and signature/receipt recovery are unchanged.

Duration mode also explains the minimum needed to include the last planned cycle. Three cycles at125-second spacing require a duration longer than250seconds, matching the model's strict deadline-after-final-cycle check. It does not extend or restart a session clock. This component handles whole-second durations only; it does not implement sub-second Cleanup delays or multi-strategy/session-wide execution.

## Verification

Seven files/59 tests pass together: duration-parts, duration-input, DCA composer/model, saved-supply sizing, random allocation and imported-session terms. Includes exact safe-integer roundtrips, one-second/24-hour boundaries, zero/empty/overflow/fraction/exponent refusals, visible unchanged invalid edits, native disabled fieldset behavior, external reset,125-second request/schedule, unchanged duration-to-deadline contract and raw-edit status invalidation. Existing total/per-cycle/random/supply/deadline regressions pass. Plain TypeScript, six-file scoped typed lint, formatting and diff checks pass. A temporary React Compiler warning on optional toString calls was resolved with explicit primitive String conversion; no memoization or checker was disabled.

Actual Chrome QA imports the real component and CSS module in an isolated4191 fixture with existing public production styles. It refuses all provider requests and keeps session saves in memory. Verified125-second HMS interval,300-second duration,250-second last-cycle hint, exact UTC deadline/schedule,60-minute refusal and correction, and explicit Save returning the reviewed session without signing.375x812 viewport has clientWidth/scrollWidth360 with no page overflow; viewport restored. Ignored screenshots: work/dca-hms-qa/valid-desktop.png, invalid-desktop.png and mobile.png. This is rendered fixture coverage, not authenticated production, funded trading or new backend qualification.

## Coordination and limits

Review current progress confirmed no overlap. This checkpoint touches only owned DCA files, new duration helper/input/module/tests and notes. Its wallet/workspace/warmup changes remain separate. No shared CSS, shell/token/holder/vault, API, SQL, provider/credential, signing, funding, submission, push or deploy change. The app/test source was explicitly frozen for that chat's one combined local build. Build result remains pending at this commit; no build pass is claimed yet. Shared HTTPS and signed-in wallet tab are preserved.

The full Proxima parity goal remains incomplete, including independent strategy/session endings, multi-strategy composition, provider-backed marketplace and token-market Cleanup. HMS entry closes a UI gap without pretending those execution requirements are done.
