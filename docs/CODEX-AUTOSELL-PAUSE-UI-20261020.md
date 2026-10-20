# Auto Sell Pause / Resume UI

Engine: `033045b`; previous shared-settings checkpoint: `7dc9f43`. Source reference for the feature is https://docs.proxima.tools/live-settings/auto-buy/. Proxima's undocumented backend semantics are not inferred from the control labels.

## Behavior

Active sessions show Pause; paused sessions show Resume. Stop remains available. Status explicitly explains retained queued amounts, discarded paused market activity, no DCA catch-up and continuing time limits. Resume is disabled while the old read or sell is settling. It reuses the same approved browser session and never prompts an extra unlock or acquires another run lock. Stop, expiry and owned project/wallet revision changes still erase the session; settings remain immutable during a run or pause until a separately reviewed edit flow is built.

## Verification

- Final offline cohort:34 files/308 tests passed. Includes9 deterministic runner pause cases and13 component lifecycle/UI cases, with same-session Pause/Resume/Stop and paused wallet-revision invalidation.
- Whole-source plain TypeScript, four-file typed lint and formatting passed. Isolated production webpack build at `033045b` plus the two UI/test overlays passed, with unchanged hashes: ignored `work/release-qa/auto-sell-pause-build-20261020/result.json`.
- Existing Chrome: actual component rendered against an isolated synthetic vault and empty feed. Run -> Pause -> Resume -> Stop completed on desktop and375px. No usable private key, real provider, signature or send exists in this harness.
- At375px: page width360, dialog client/scroll320/320; Close, Resume and Stop fit horizontally, with each button bottom781 inside the812px viewport. Body scroll does not hide the footer. Screenshots: ignored `work/auto-sell-pause-browser-20261020/paused-desktop.jpg` and `paused-phone.jpg`.
- Responsive override initially affected the active Proxima reference tab rather than the background test tab. Its visible No active AutoSell session status was checked before temporarily navigating it to the local harness. Original Proxima live-token URL was restored and the override reset. No Proxima financial or session action was performed.

No deploy, hosted SQL, provider/credential/cron setting, real vault unlock, signature, funded trade or stock signing gate change. Tests do not establish funded execution proof or durable background operation.

## Next

Edit without starting over requires an exact changed-settings review that preserves already consumed budgets, elapsed clocks, filled orders and pending/uncertain outcomes. It must not silently rearm limit rows or renew deadlines. Custom slippage, automatic Generate Activity sessions, alternative routing and the broader feature matrix remain open. The goal is not complete.
