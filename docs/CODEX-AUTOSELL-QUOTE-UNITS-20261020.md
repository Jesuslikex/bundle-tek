# Auto Sell quote-unit audit and correction

20 October 2026. Source checkpoint follows d0f287f. No deployment or funded activity.

Confirmed bug: the feed discarded the verified quote mint from observePoolTrades. The Min. SOL trigger compared its amount with quoteAmount using Number, even when that amount was denominated in USDC or another token. Values immediately below a threshold could also round up in floating-point arithmetic.

Correction: carry the verified quote mint through the browser feed. Min. SOL requires the wrapped-SOL mint and an exact bounded decimal comparison. Unknown units and other quote tokens cannot queue a response under this trigger. No USD-to-SOL conversion or assumed native denomination is introduced. The session activity log explains a quote-unit refusal and suggests the existing Rate or Min. Token triggers, which retain their existing behavior for other quote assets. The existing decoder still checks pool and trade identity before the feed supplies these units.

Verification:13 related files/104 tests pass together. Fifteen quote-trigger cases cover unknown/USDC/other quote units, exact threshold boundaries beyond Number precision, malformed amounts, other trigger modes and the real runner's refusal log/no-send behavior followed by a valid synthetic SOL event. Two feed tests use the real pool/trade decoders and synthetic HTTP responses. Existing pool identity, session, editing, lifecycle and execution cases pass. Typed lint and formatting pass for all seven changed source/test files. Whole-project TypeScript (`tsc --noEmit --incremental false`) passes. No new production build, live-provider/browser or funded execution proof is claimed for this pure-rule/feed change.

## Remaining parity found in this audit

Proxima's https://docs.proxima.tools/live-settings/auto-buy/ documents exclusion of own/whitelisted wallets, shared session controls and editing without restarting. Our source excludes own and whitelisted buyers, and the recently verified paused edit path preserves session progress. Private Proxima backend behavior is not established by its docs.

Proxima's https://docs.proxima.tools/wallets/generate-activity/ documents fixed/range amounts, loop count, delay, Required/Estimated, alternative routing, per-wallet progress/transaction count/volume and session cancellation. Bundle has the amount/plan controls, manual exact transaction review and recorded cycle/lot accounting. It does not yet provide the same automatic session runner, per-wallet session summary or alternative routing. Recorded receipts and lot performance must not be presented as an active background session or whole-wallet history. These gaps remain open; completing this correction does not establish full parity.
