# Recovery after closing an unconfirmed planning save

The owned launch-layer entry now retains a warning outside the planner when it is closed after a save attempt whose result has not been validated. Closing still aborts local work; it does not promise to undo a server commit. Reopening makes no automatic request, and the existing planner still requires loading saved context/history before review and save.

The request body is built before marking an attempt unconfirmed. Only a validated, current save response confirms that attempt. Local UI attempt numbers distinguish an old dismissed warning from a newer pending save; they are never sent to the server and grant no authority. A later successful save does not erase an older closed-save warning. Dismissing only acknowledges the displayed warning, preserves a newer pending attempt and returns keyboard focus to the planning button.

The warning uses a pre-mounted native output/live region, a text-only description target, context-aware reopen guidance and an owned CSS module with a44px dismissal target. Browser DOM checks verify those bindings and focus behavior; actual screen-reader announcements are not qualified.

## Verification

-11 related test files/126 tests pass, using the existing real entry/planner/authenticated route/service/disposable SQL composition. One test commits an actual planning row before holding its response, then closes, releases the late response and reopens. Other tests cover local cancellation, a later confirmed save, dismissing an old warning while a newer save is pending, a validated-save close without a warning, and closing pending reads without a save warning.
- An explicitly refused stale-wallet save creates zero rows but conservatively leaves an unconfirmed-attempt warning on close. This intended behavior is pinned by a test; HTTP error statuses are not treated as proof that earlier uncertainty was resolved.
- Typed lint and formatting pass. The final isolated production build including TypeScript passed against base `d1a157d` plus the five owned source/test/CSS overlays, with matching before/after hashes. Sanitized result: `docs/qa/20261019/layer-progress/close-build.json`.
- Current real components in a synthetic browser fixture show the warning surviving close, late response and reopen, with one planning save, two explicit context/history GETs and zero extra requests on reopen. At1440/375/320 there is no horizontal overflow, the dismissal target is44px, and dismissal returns focus while leaving the empty announcement region mounted. Screenshots/measurements are alongside the build report. These are component browser checks, not actual signed-in app, production database or live-provider qualification.

Actual restricted Claude review returned only `claude-opus-5-5`, with tools disabled and no fallback. Opus found no blocking defect and recommended committing after the build passed. Codex then adopted its request-body preparation, persistent announcement-region and open-state wording suggestions, added focus restoration and refusal coverage, and independently reran the final tests/build/browser checks. Opus did not run tests or browse Proxima; its review preceded that final polish.

## Limits and safeguards

The warning is local to the current keyed entry. Changing selection/project, unmounting the entire screen or reloading loses it. No durable uncertainty or navigation-global recovery is claimed. Server-side exact matching and idempotent planning storage remain unchanged, as do all parsing, cancellation, history admission, consent, funding and signing gates. A warning dismissal is neither a save confirmation nor execution approval.

Only Codex-owned launch components/tests/CSS and documentation changed. No protected Claude layout, account-session, API, library or committed migration was edited. No deployment, hosted SQL, provider/credential/cron change, real wallet unlock/sign/send or funded trade.
