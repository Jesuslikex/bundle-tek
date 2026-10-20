# Auto Sell paused-session edit UI

20 October 2026. Builds on the exact edit engine in bf17bb2.

The paused, settled session now offers Edit. Settings can be changed without another vault unlock. Review changes presents the human-readable before/after differences, accounted sales, queued amounts, removed unsent queues, any explicitly reactivated strategies and limits that would immediately end the session. A separate checkbox starts unchecked. Apply requires that exact review; it leaves the session paused. Resume remains a separate action.

Every field mutation, mode change, added strategy and removed strategy clears review/approval. Changing back to the earlier value cannot restore consent. Cancel, Close and Escape discard unapplied changes and restore the original configuration. Session expiry discards the draft. Existing wallet scope and initial delay remain fixed. Strategy duration and DCA interval fields initialize from the retained configuration when cards remount.

Verification:

- All 10 Auto Sell files pass together, 84 tests. Four added component cases exercise exact unchecked approval, mutation invalidation including mode buttons, Cancel and Close restoration, fixed delay, unchanged unlock count and paused apply.
- Broader Auto Sell/warmup regression: 36 files, 331 tests pass together using the existing offline harness.
- Typed lint and formatting pass for the three changed implementation/test files. Whole-project TypeScript (`tsc --noEmit --incremental false`) passes. Final isolated Next production build passes (base bf17bb2 plus the three owned UI/test overlays, exit0, unchanged source hashes).
- Actual component/CSS in the existing Chrome session with synthetic vault/feed: desktop review shows 10% to 20%, starts unchecked, applies while paused and retains the activity log. Phone375x812 review has no horizontal overflow (document client/scroll360/360; modal320/320), and all footer controls are44px tall and within the viewport. Cancel restores10%. The fixture was stopped and the Proxima reference restored.

Screenshots remain local under work/auto-sell-pause-browser-20261020/edit-review-desktop.jpg and edit-review-phone.jpg. No real provider, wallet secret, signature or broadcast is available in this fixture. This is UI/engine verification, not funded execution proof or production verification.

Reference: https://docs.proxima.tools/live-settings/auto-buy/ documents Pause/Resume and Edit without restarting. Its private execution behavior is not established by those docs. Custom session slippage, Auto Buy and the broader parity audit remain separate work. Existing protected-minimum, signing, send and recovery paths are unchanged. No deployment, hosted SQL, provider/credential/cron change or funded activity.
