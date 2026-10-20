# Auto Sell original market timestamp

20 October 2026. Follows593735a. No deploy, hosted SQL, provider/credential/cron change or funded activity.

Confirmed bug: the feed dropped the original trade timestamp. Every successful poll reset marketCapAt to browser arrival time, so repeatedly returning the same old price could keep ranged DCA and limit targets eligible indefinitely.

The feed now preserves the decoder-validated timestamp. A shared pure selector admits only positive finite prices with an explicit UTC timestamp at or before the current clock and no older than the existing60000ms limit. It selects the newest admitted source timestamp. Missing, malformed or future timestamps cannot establish a price. The runner stores that timestamp rather than HTTP arrival time, refuses to roll evidence back to an older response, expires evidence before applying price ranges and also invalidates cached evidence when the local clock moves behind it. The existing60-second boundary remains inclusive; it was not loosened.

The configuration preview uses the same selector and clears its price when evidence is absent/stale or the read fails. Aborted preview reads cannot replace its state. Price-independent strategy behavior, Counter event deduplication, original approval limits, minimum-output checks, custody, exact signing and send/recovery paths are unchanged. This does not establish a new age policy for Counter event identities or implement automatic warmup.

Verification:14 related files/117 tests pass together, including11 new selector/runner tests and two new React preview cases. Tests cover the exact60000/60001ms boundary, missing/malformed/future timestamps, newest valid selection, non-finite prices, repeated successful reads, stale startup limit targets, fresh recovery, older responses and clock reversal. Feed tests confirm source timestamps survive the real decoder. Existing deterministic runner fixtures now explicitly identify their synthetic source times. Whole-project TypeScript, typed lint and formatting pass. The final isolated production build passes (593735a plus the11 source/test overlays, exit0, unchanged source hashes).

Existing Chrome renders the actual component with local synthetic fresh/stale/failed feed controls and no wallets. A configured$1 lower range is eligible with fresh data and becomes ineligible after closing, choosing stale evidence and reopening. No Run action, vault unlock or provider request occurred. Screenshot: work/auto-sell-freshness-browser-20261020/stale-price-preview.jpg. No layout or responsive-style change is included. This synthetic check is not live-provider or funded proof.

Automatic Generate Activity sessions and alternative routing remain open; recorded per-wallet progress is already committed separately. Full Proxima parity remains unproven.
