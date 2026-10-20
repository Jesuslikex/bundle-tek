# Auto Sell shared session rules

Separate engine step after Generate Activity dialog `53a26a6`. Julian transferred ownership and requested Proxima parity one feature at a time. No deploy or funded actions.

Optional runner session rules add a start delay, one combined maximum percentage of supply and one whole-session duration. All default to unset/zero, preserving existing strategy behavior. Inputs are validated before a run; delay/duration are bounded to whole seconds within 24 hours. Percentage caps use existing integer arithmetic and reject zero, over 100%, malformed values and caps smaller than one raw token unit.

All strategy clocks start after the delay. Counter history is rebaselined, never buffered for a burst of pre-start sells. DCA and limit scheduling and every send remain held until that time. Duration is measured from the delayed start, with an independent abort deadline so a pending feed cannot leave execution active indefinitely.

The cap sums all strategies' sold/uncertain amounts, reserves in-flight amounts and clips the final requested sell to the remaining shared allowance. Reaching the allowance with a pending sell does not abort that sell: terminal/uncertain consumption stops the session afterwards. Failed unsent amounts remain available only through the original retry/abort rules. Uncertain submissions consume their allocation and cannot be resold. The existing send-once, minimum-output, custody, receipt and failure rules remain unchanged.

Verification: six deterministic session tests plus all existing Auto Sell tests pass. Final combined run, including the follow-up UI tests: seven files/47 tests. Tests use injected clocks, timers, synthetic feeds/sell functions, no wallet or provider. Typed lint and plain TypeScript pass for the engine and contemporaneous UI. A pending feed test proves the separate deadline is effective without a completed poll.

The engine is committed separately from its UI wiring for review. No migration, provider, environment, cron, real wallet, signing gate or deployment change. These are browser-tab sessions, not durable background execution. Custom session slippage and pause/resume/edit remain separate work.
