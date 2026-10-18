# DCA start delay

Local implementation, 18 October 2026. Codex scope: DCA composer, existing pure request helper and their tests. The other Bundle chat owns warmup. No provider, credential, database schema, remote SQL, cron, signing gate, push or deployment change.

## Reference and behavior

The retained REA strategy-form observation ev_5e2f23d15920096f6dc8db94c6aa5404f5f4a06e75ebfd8d3919f763926b3849 includes Proxima's start delay. Its exact backend timer semantics are unknown. See CODEX-PROXIMA-STRATEGY-COVERAGE-20261018.md for scope and private evidence location.

Bundle now offers calendar start or a start delay in hours/minutes/seconds. Delay supports 1..86400 exact whole seconds. Clicking Set start from delay captures browser time once, shows a fixed UTC start and uses the existing immutable schedule contract for every cycle. No relative timer is sent to the server. Saving, re-rendering and retrying preserve the captured time. Setting the start again starts a new delay; editing any delay unit or switching the start method clears the delayed capture. Calendar mode keeps its previous value. Duration ending remains anchored to the selected scheduled start.

This deliberately exposes when the delay starts: the capture click, before save. Eligibility may arrive while a user reviews or retries. It is not an execution promise, a background timer, a new aggregate session budget or permission to sign. Each cycle still requires its existing review, approval and separate submission. The request, schema, server ownership/revision checks and recovery behavior are unchanged.

## Verification

- 58 passing cases across eight distinct files: composer, request helper, supply sizing, random allocation, market-cap bounds, imported session model, sizing and status. New cases cover exact millisecond anchors, one-second/day limits, invalid clock/delay inputs, fixed cycle and duration dates, failed-save identity reuse, raw-edit/mode invalidation, locked workspace and absence of requests before explicit save.
- Plain TypeScript passed; typed lint passed on the four owned TypeScript/test files after removing the obsolete calendar-only memo dependency. Formatting and final diff checks are part of the checkpoint.
- Combined Next webpack production build66835 completed successfully, with frozen DCA source and the other chat's warmup recovery changes. Compile24.3seconds and TypeScript23.9seconds. Build log: work/release-qa/warmup-field-recovery-build-20261018.log. The build owner confirmed terminal exit0; no second shared build was started here.
- Own isolated in-memory browser fixture on loopback4194 verified calendar-to-delay selection, 125-second capture, exact per-cycle times, explicit synthetic save, invalid60-second edit refusal and capture invalidation.1440px client/scroll1425,375px client/scroll360,320px client/scroll305. Screenshots: work/dca-delay-qa/desktop.png, mobile.png and mobile-saved.png. Browser fixture uses no provider, wallet keys or database writes. It tests rendering and client response handling, not real hosted persistence or funded execution. Its tab was closed and shared viewport restored; the other chat's real signed-in tab and HTTPS server were untouched.

Broader parity still requires independent strategy/session stopping rules, multi-strategy wallet accounting, vendor-style market redistribution Cleanup, supported providers and integrated live/funded qualification under separate authorization. This feature does not close those gaps.
