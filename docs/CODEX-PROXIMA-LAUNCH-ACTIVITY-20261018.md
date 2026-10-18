# Proxima account inspection and saved Pump launch activity

18 October 2026. This is an owned local checkpoint on top of `358f58d`, not a production release or a claim of complete Proxima parity.

## Current reference and connection

The reboot stopped the existing Windows-to-WSL CDP relay. Windows Chrome still answered on loopback port 9223, while the WSL loopback connection was refused. Restarting the existing approved `Desktop/REA/results/proxima-deep-20261012/cdp-relay.mjs` restored actual REA discovery and passive inspection. No browser/profile/MCP configuration was changed. The temporary process is not a scheduled service and must be revalidated after another reboot.

- Discovery: `ev_c96b27779305ad4ab81a45b612e1e56a622473ed32395c5a9c70203366aa71b8`.
- Passive account inspection: `ev_48c3948683b8270264ac1b76b355ced22c8840693f62c4d1d1816d0d8c52c1a7`, 15:58:07.053 to 15:58:08.234 UTC, Chrome 155, existing `https://app.proxima.tools/account` target.
- Current observed controls: Launch statistics, Recent launches, Best P&L, Cumulative P&L, Daily P&L, Win Rate, Calendar and P&L by chain. Their presence does not establish backend computation, cost coverage, custody or execution behavior.
- Complete passive record is private at `C:\Users\Julian\Desktop\REA\results\proxima-account-reconnected-20261018T155807Z.json`; SHA-256 `8c7841ade557276b45e4cb9dac58551f6e07f015eca0ee4512b9554c8e8d3989`. Account-specific accessibility text stays outside Git. The capture excludes raw network bodies/headers, cookies, storage values/keys, source code and WebSocket payloads; it is limited to the attach window and allowed origin, with no truncated sections.

No navigation, account action, wallet selection, signature or transaction was performed in Proxima. This supersedes the preceding reconnect attempt's REA-unreachable status.

## Bundle change

The account performance screen now includes saved **Pump group** launch activity across the signed-in owner's projects. It shows saved groups, groups with matching finalization records, reviews and missing finalization evidence. The eight newest saved reviews are disclosed separately, with compact token addresses, full-address expansion, recorded states and timestamps. This is a separate history surface from the existing exact buy-to-sell performance timeline.

The authenticated `GET /api/account-launch-activity` rejects query parameters and reads owner-filtered counts plus the bounded recent list in one database batch. Only `pump-launch-group-review-v1` records are included. A closure must match owner, review and exact retained receipt; a matching finalized closure is required for the finalized count. Missing storage or malformed/contradictory result rows withhold the complete response. No signatures, receipts, project documents or provider credentials are returned. No schema or migration is added.

The client validates nonnegative safe counts, complete bounded sampling, date/status/address shapes, matching settlement timestamps, chronological ordering and sample/category consistency. Refresh clears stale counts. Non-JSON errors provide retry, an expired session provides sign-in, and a 15-second deadline makes a hanging read retryable. Abort and unmount checks prevent late responses from replacing a newer result.

Phone rendering exposed an actual issue with the shared table's minimum width: its numeric column was off-screen inside a horizontal scroller. The final owned CSS module uses responsive definition-list metric cards and stacked recent records. Recent records, full addresses and methodology start collapsed. No shared shell, global CSS, funding or account-session file was changed.

## Exact verification

- Final focused run: **19 passing tests across four files** (`lib/account-launch-activity.test.ts`, route tests, mounted/static activity component tests and existing performance-summary regression tests). The route runs real Request/Response calls against disposable local SQLite through the production Turso/D1 adapter, using minimal query-contract tables and controlled authentication. It tests owner and receipt isolation, full counts versus eight-row sampling, format filtering/order, empty history, malformed rows and absent closure storage. It does not test the entire migration/launch execution protocol.
- Mounted component cases cover non-JSON failure/retry, expired authentication, a hung request and late stale response, refresh without stale counts and unmount cancellation. These use controlled fetch replies, not an authenticated hosted session.
- Project-wide `tsc --noEmit` passed after the Link/appendChild corrections, before the final count-table-to-definition-list markup/CSS change. The final source subsequently passed the production build's complete TypeScript phase. Final seven-file type-aware lint and eight-file formatting checks pass after the markup change. No new full-suite claim is made here.
- Node **24.19.0** `next build --webpack` passed to terminal exit **0** (owned handle `81715`) in `work/release-qa/account-launch-activity-build-20261018`. Webpack compiled in 61 seconds, TypeScript finished in 41 seconds, all six static pages generated and the dynamic account-launch-activity route was listed. The snapshot copied 2,172 current tracked/untracked files without environment files, using a shared node_modules junction. All 1,844 non-Markdown copied files, including 1,830 source/config files and all six peer-owned funding recovery files, still matched both snapshot and checkout after the build. The build warned that lockfile inference selected the parent workspace as the tracing root; this is an isolated application-output build, not a hermetic dependency sandbox. It did not change the root `.next` or restart the live HTTPS helper. Log: `work/account-launch-activity-qa/production-build.log`, SHA-256 `472e8a7fb8c26795e8b2f6f09ab62ea55406fa51f9c009bf389c7ac7cd17e958`.
- Actual current component, actual Button and owned module CSS rendered in the existing Chrome connection with prior compiled global styles and explicitly synthetic account replies. Verified 1440px, 375px and 320px widths, collapsed defaults, all metric values visible, expanded records/full address, failed-read retry, sign-in link and empty state. At 320px the document was 305px wide with a vertical scrollbar and no descendant overflow; at 375px the document was 375px wide. This is component browser QA, not signed-in integrated application or real-device evidence.
- Ignored harness/screenshots/source hashes: `work/account-launch-activity-qa/`. All eight owned source hashes remained unchanged after the final focused checks and browser QA. The fixture tab was closed, viewport override reset and its exact owned server stopped. The separate Proxima relay remains available.

## Remaining scope

This does **not** calculate launch P&L, mark-to-market value or complete launch costs, count every chain/venue/single-launch flow, link rows directly into project recovery, or establish audited profitability. Bundle's retained group records still explicitly withhold complete economic settlement authority. Full launch-level economic accounting and broader adapters, settlement recovery/qualification, marketplace execution and signed-in hosted verification remain unfinished under the full Proxima goal.

No funding, wallet unlock, signature, transaction, provider change, remote SQL, push or deploy occurred. Peer-owned funding recovery and account-session work is excluded from this checkpoint; the user-authored AGENTS coordination update is preserved.
