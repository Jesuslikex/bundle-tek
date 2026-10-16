# Live unsigned stock runtime qualification

Scope: finish the read-only 32-slot stock runtime qualification with signing hard-disabled. No deployment, provider/credential/cron change, remote SQL, user wallet unlock, signature or submission. Probes use a public on-chain system-account reference in an isolated in-memory SQLite database, not the user's wallets or a claim of key ownership.

## First observed blocker: provider display precision

The first bounded live order-first attempt stopped before simulation/code scans on `Invalid order price impact estimate.` All 13 HTTP requests returned 200, no 429, and no transaction was sent. One additional bounded unsigned-order metadata inspection observed a string `-0.0004986315722698763`, 19 fractional digits. Only that numeric field/type/length were displayed; credentials, wallets and packets were not printed.

The display-only parser now preserves up to 60 fractional digits, still bounded to absolute value <=100 with exact decimal checks (including values that Number would round to 100). It never rounds a tiny value to zero or alters transaction economics. New tests retain the captured precision and reject exact over-bound values. Three quote/review/bounds files pass 53 tests; scoped typed lint is clean. Minimum-output/slippage/input/fee checks are unchanged.

## Qualification lifecycle (next checkpoint)

The internal qualification entry point follows initial Jupiter preview -> unsigned packet -> fresh quote/owned preflight -> one traced runtime simulation with both complete code scans and the existing final custody/lifetime tail -> immutable local-only review evidence. It does not simulate an ordinary candidate first, reuse a scan, create an approval, or enable signing. There is no client-selectable qualification flag. Runtime/trusted policy/reservations remain false as before. Live receipts will record actual slots and stage timing, not infer success from unit tests.

The entry point and reusable one-attempt script are separate from the display-precision repair. Five qualification tests prove exact quote/order/quote sequencing, one simulation, all six header/body/recheck reads per fixture program across two observations, changed-code/33-slot/cancellation refusal and no client flag. Existing owned service and ordering tests also pass (23 cases). The script permits only read/quote/original unsigned simulation methods, captures only sanitized metadata, stops on 429 and makes no automatic retry. It uses the configured endpoint unchanged; it does not access a real app database.

## Measured bottleneck and bounded optimizations

After the precision repair, one attempt refused an inconsistent/stale chain Clock before scanning; a later retained public reference changed between reads and was refused. Fresh public-transaction reference discovery then reached one traced simulation and both full code observations: 59 HTTP 200 requests, no 429, 11,654.75 ms for the order-first lifecycle. Fresh quote slot 457647003 reached final code metadata slot 457647046, already 43 slots before the remaining custody tail. It correctly failed to publish. The full receipt retains Clock slot/Unix/skew and logical read timings; no freshness tolerance was relaxed.

Two independent optimizations follow this measurement: (1) the explicit four-read code profile uses native base64 decoding into owned Uint8Array bytes after the unchanged canonical envelope validation, while default group serial code remains unchanged; binary-vector/full-hash and malformed-base64 tests verify parity. (2) full-account packing now uses bounded size hints (64 KiB per unknown account) for scheduling, instead of assuming every small wallet snapshot fills the entire response allowance. These are hints only. Max two methods/four HTTP, normal 512-KiB and code 2-MiB whole-envelope caps, aggregate 1-MiB raw code, exact IDs/order/floors and no-retry policy remain unchanged. Underestimation rejects the entire envelope before any result resolves. Four targeted files / 72 tests pass. Each optimization is committed separately for Claude.
