# Counter Buy ExactOut instruction inspection

Source commit **75fb371** adds proposal-bound inspection needed for the Counter Buy review flow. It does not yet expose preparation or signing controls.

The current Counter Buy quote adapter records an exact output token target and an independently entered maximum SOL swap-input budget. Existing Jupiter v2 preparations and their signing checks use ExactIn. This checkpoint keeps those paths separate: `decodeJupiterRoute` continues rejecting ExactOut, while `decodeJupiterExactOutRoute` reads the shared v1 ExactOut instruction's output-first trailer. Both reuse the existing bounded venue-field decoder.

The layout is checked against Jupiter's [published CPI IDL at commit 12bc5f67b94a2c3edc74d6e721a19442124a0bad](https://github.com/jup-ag/jupiter-cpi/blob/12bc5f67b94a2c3edc74d6e721a19442124a0bad/idl.json). Its discriminator is independently derived in tests from SHA-256 of `global:shared_accounts_exact_out_route`, first eight bytes: `b0d169a89a7d453e`. Venue fields continue using the separately captured, hash-pinned schema documented in `jupiter-route-schema.json`. These are static interface evidence, not current deployed-program verification. The current [v1 swap API](https://developers.jup.ag/docs/api-reference/swap/v1/swap) builds an unsigned transaction from a quote; this checkpoint makes no provider request to that endpoint.

`assessJupiterExactOutRoute` compares the exact token output, quoted input, slippage, conservative integer maximum input, user's input budget, authority/signature role, writable source/destination, mint addresses, standard token-program positions, program account, absence of a platform fee and connected acyclic route graph. It requires thirteen resolved base accounts and one Jupiter call. Unknown layouts remain unavailable; malformed or mismatched data remains rejected. Its result always retains `executionAllowed=false` and `instructionsVerified=false`.

`reviewCounterBuyRoute` binds that assessment to a decoded active Buy plan and retained proposal identity, exact project/plan revisions, mint, target, independently supplied input budget, expected quote source/mode/slippage and a fresh quote window of at most thirty seconds. It rejects changed/expired context and never modifies or consumes the ledger. A field mismatch is retained as a failed assessment, never converted to signing clearance.

## Verification

- **254 tests across six files passed**, including nine new tests with multiple adversarial cases and the existing 204-case ExactIn route suite. Existing unsigned-order and simulation checks passed too. Report: `work/release-qa/counter-exactout-inspection-tests-20261014.json`.
- Actual-source TypeScript exited zero using the existing runtime-only exclusion config. Five-file typed lint exited zero. Production build exited zero; log: `work/release-qa/counter-exactout-inspection-build-20261014.log`.
- All **1,084 source hashes** remained unchanged through verification, digest `c1aace97d6edc28c08d88d0881fbada093c47ab0942149c983d0bd9e432137be`. Snapshot: `work/release-qa/source-counter-exactout-inspection-20261014.json`.
- No rendered UI check applies: this checkpoint changes five library/test files, with no UI or authenticated route change. Tests use synthetic instruction/quote evidence and no keys.

## Remaining integration

This library is not yet called by an authenticated preparation/signing route. The next integration must build and inspect an actual ExactOut unsigned packet, verify current database/project/wallet context and source eligibility, resolve token account ownership/extensions, assess SOL wrapping and all debits/fees, simulate that same packet, and bind its immutable hash to explicit user approval. Durable proposal-use reservations must prevent concurrent or retried approvals from reusing a signal and preserve recovery of existing signatures/receipts. Shared strategy/session limits remain unfinished. Do not relabel an ExactIn amount as the Counter Buy token target.

Claude UI/protected source, historical SQL, hosted state, provider configuration and CROP candidate are untouched. The two pre-existing whitespace edits remain unstaged. Nothing pushed, saved as a hosted version, deployed, signed or submitted.
