# Monitoring retry task ownership

Codex owns only lib/foreground-market-feed.ts and its test, lib/supply-monitor-read.ts and its test, components/saved-supply-monitor.tsx, and this task note.

Claude owns the Watch wallet handoff in components/imported-supply-tracker.tsx and its focused tests. Codex is not editing those files or the supply-history route/tests.

Retry policy: 429, temporary network failures, 500/502/503/504, and the exact POST sample-overlap 409 retry with exponential backoff from 30 seconds to 5 minutes, jitter, and Retry-After support (longer server hints are honored up to 24 hours). Other failures remain terminal. Reads remain serialized and foreground-only; stop/pause cancels retries. A successful POST followed by a failed history refresh retries the GET without posting another observation.

The generic 409 "Project, wallet, or supply history changed during this read. Reload." remains terminal because this response cannot distinguish a harmless concurrent observation from an invalidated wallet or project. No server guards were loosened, and the shared 15-second gate is unchanged.

Validation: 15 focused tests passed, TypeScript passed, scoped lint passed, and tracked-file whitespace checks passed. Tests cover retry classification, HTTP Retry-After, backoff/reset/jitter, serialization, abort/stop/visibility handling, and the existing supply-history/chart tests. No live provider requests, browser workflow QA, signing, or deployment were performed for this change.
