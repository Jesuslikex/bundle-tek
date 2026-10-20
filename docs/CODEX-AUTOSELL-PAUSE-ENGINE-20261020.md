# Auto Sell Pause / Resume engine

Base: `7dc9f43`. Julian transferred ownership and requested Proxima parity. Reference: https://docs.proxima.tools/live-settings/auto-buy/ describes Pause, Resume, Edit and End. No active Proxima session was started to inspect its internal pause timing; the policy below is Bundle's explicit tested behavior.

## Policy

- Pause retains the same approved session and browser lock. No new market reads, scheduling or sells start while paused. It aborts the existing read/sell signal so unsigned and unsent work stops.
- A submission already started retains the existing executor's one-send/outcome behavior. A signed/uncertain amount stays charged; it cannot be resold. Resume is unavailable until both the old read and sell settle, including an abort-ignoring provider read.
- Resume creates a new cancellation scope, keeps all counters, queued amounts, filled limit IDs, failure/backoff gates and shared budgets. It rebases Counter history and clears the prior market-cap observation. Paused trades are not replayed. DCA waits at least a new interval instead of stacking missed ticks.
- Paused time counts toward the original whole-session and per-strategy wall-clock limits. The whole-session deadline remains independently scheduled; a local timer checks per-strategy expiry while paused without reading a provider. Stop permanently ends this runner instance.
- Manual poll entry clears an already scheduled poll, avoiding duplicate timers when resuming or explicitly ticking the exposed test entry point. Old read scopes cannot continue a new scope's scheduling.

No new or expanded signing consent, API, credentials, provider, cron or migration. Existing one-click Run authorization still defines the session; Pause does not unlock a wallet or authorize a new session. Browser-only vault retention while paused is disclosed by the follow-up UI. Closing the tab, Stop, expiry or project/wallet context changes still clears it.

## Verification

Nine deterministic injected-clock/feed/sell tests cover: fresh Counter baseline; pending abort-ignoring reads; unsent abort/requeue with retained backoff; submitted outcomes and shared cap; uncertain amounts; no DCA catch-up; global deadline; individual expiry; Stop. Existing Auto Sell tests pass alongside them. Engine cohort:8 files/59 tests. Full source TypeScript and typed lint pass with the contemporaneous UI wiring. No real provider, wallet, signature, send or funded test.

This engine checkpoint is separate from its UI commit. Edit/review of changed settings is still outstanding, as are custom slippage, automatic warmup sessions, alternative routing and broader parity. No deploy.
