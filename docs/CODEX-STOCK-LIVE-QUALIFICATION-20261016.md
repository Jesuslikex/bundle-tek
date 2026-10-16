# Live unsigned stock runtime qualification

Scope: finish the read-only 32-slot stock runtime qualification with signing hard-disabled. No deployment, provider/credential/cron change, remote SQL, user wallet unlock, signature or submission. Probes use a public on-chain system-account reference in an isolated in-memory SQLite database, not the user's wallets or a claim of key ownership.

## First observed blocker: provider display precision

The first bounded live order-first attempt stopped before simulation/code scans on `Invalid order price impact estimate.` All 13 HTTP requests returned 200, no 429, and no transaction was sent. One additional bounded unsigned-order metadata inspection observed a string `-0.0004986315722698763`, 19 fractional digits. Only that numeric field/type/length were displayed; credentials, wallets and packets were not printed.

The display-only parser now preserves up to 60 fractional digits, still bounded to absolute value <=100 with exact decimal checks (including values that Number would round to 100). It never rounds a tiny value to zero or alters transaction economics. New tests retain the captured precision and reject exact over-bound values. Three quote/review/bounds files pass 53 tests; scoped typed lint is clean. Minimum-output/slippage/input/fee checks are unchanged.

## Qualification lifecycle (next checkpoint)

The internal qualification entry point follows initial Jupiter preview -> unsigned packet -> fresh quote/owned preflight -> one traced runtime simulation with both complete code scans and the existing final custody/lifetime tail -> immutable local-only review evidence. It does not simulate an ordinary candidate first, reuse a scan, create an approval, or enable signing. There is no client-selectable qualification flag. Runtime/trusted policy/reservations remain false as before. Live receipts will record actual slots and stage timing, not infer success from unit tests.
