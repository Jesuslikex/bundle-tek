# Auto Sell session UI and parity checkpoint

Engine commit: `dfd1428`. Generate Activity UI: `53a26a6`. Lifecycle fix: `67f0763`.

## UI wiring

Advanced Options now passes exact optional session start delay, duration and one combined maximum percentage of supply into the runner. Invalid time units or caps block Run before any vault unlock. The existing duration-parts parser rejects fractional, negative and overflowing minutes/seconds. Limits become immutable while unlocking/running; blank means unset. Session duration starts after the delay and both shared end conditions stop all strategies. Per-strategy end conditions still affect only that strategy.

Auto Sell now uses a native modal for keyboard focus containment, Escape and focus restoration. Closing or escaping during a pending unlock cancels that attempt and erases any late session. Closing configuration during an already running session retains the explicitly approved behavior: the session continues until Stop, an end condition, pagehide or context invalidation. No new signing authority, credentials, API shape or transaction admission rule was introduced.

Custom session slippage is explicitly unconnected; existing protected quote minima remain unchanged. The session maximum is currently percentage-of-supply only. Pause/resume/edit and durable background execution remain separate work. Do not present these as completed.

## Verification

- Final combined related run:33 files/297 tests passed with external Node network blocked. Includes7 shared-rule cases and11 Auto Sell component lifecycle/UI cases. A follow-up keeps no seen-trade backlog during start delay and proves that buys during the delay or its initial boundary baseline are never replayed afterwards.
- Typed lint/format pass. Plain TypeScript passed after engine/UI wiring; final production build also typechecks the exact final overlays.
- Native-modal rendering and shared settings were checked in existing Chrome with synthetic fixtures. Invalid zero cap shows a visible error; valid delay/cap/duration values retain correctly. No unlock or Run in Proxima; the local harness has no usable keys/provider/signature/send.
- At375px: measured viewport375, Auto Sell dialog322px wide, client/scroll320/320, with no sideways overflow. Header/footer remain outside its scrolling body. Native centering was corrected after this rendered check. Screenshot: ignored `work/activity-autosell-browser-20261020/auto-sell-phone.jpg`. Viewport reset and original Proxima URL restored.
- First isolated build compiled successfully but failed its unchanged-source guard because the centering CSS was edited during the build. It is retained as such, not counted as a final pass. Both cached rebuilds passed; the last includes all five final source/test overlays, including the bounded pre-start history follow-up, and verifies unchanged hashes. Evidence: ignored `work/release-qa/auto-sell-session-ui-build-20261020/result-receipt.json`, base `dfd1428`, exit0, unchanged=true.

No deployment, hosted SQL, funded activity, provider/credential or cron change. Stock signing stays off. Git deployments remain disabled.
