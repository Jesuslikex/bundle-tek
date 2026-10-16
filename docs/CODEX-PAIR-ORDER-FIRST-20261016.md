# Order-first stock pair review

User approved the new review flow on 16 October, including an independent bound, short authorization and route/impact disclosure. This supersedes the pending-proposal status in earlier notes. No deployment or signing enablement is authorized.

## Step 1: immutable economics contract

`pair-order-first-review.ts` binds the order's decoded minimum, exact input, packet hash, candidate hash, fresh reference minimum, initial server preview, fees, rent, venue steps, provider impact estimate and expiry. Existing `assertPairOrderQuoteBounds` is unchanged: the new order must meet the fresh reference minimum and optional absolute minimum. Prior approved minima never change.

Independent comparison is encoded minimum versus initial server preview expected output for the same side, exact raw input and asset policies. A signed raw difference and truncated basis-point display are retained. The extra unchecked acknowledgement uses the exact absolute integer cross-product, strictly above 2%, including improvements. It never overrides the fresh slippage or absolute bound. The source and timestamp are disclosed; this is not a separate exchange oracle.

Price impact is a bounded provider estimate when returned on wallet-bound preparation, otherwise unavailable, never silently zero. Venue names/weights come from the reviewed packet decoder. No provider route label is treated as an attestation. The provider field is documented in Jupiter's API: https://developers.jup.ag/docs/api-reference/ultra/order . No API migration was made.

Verification: four files / 51 tests, standalone TypeScript pass. Exact 2% boundaries, BigInt precision, stale/context/decoded changes, raw minimum/consent/hash/fee tampering and malformed impact covered. Existing quote-bound regressions still pass.

## Next steps

Add the server-owned order-first preparation/store and guarded short authorization, then an isolated review component. No token layout edits without the exact patch and Claude/user approval. Keep 32 slots, both full code scans, serial default group reads and all existing consent safeguards. Stock signing remains off; full live runtime qualification, trusted policy and reservations remain prerequisites.

## Step 2: owned preparation and immutable storage

Prepare a server baseline, then exactly one unsigned order, then the fresh reference through the existing owned preflight/decoder/simulation lifecycle. Tests prove quote/order/quote ordering and one-unit fresh-minimum refusal. A WeakMap-backed server-only capability permits exactly two same-owner/request quote reads within 25 seconds while charging the existing 15-second public gate once. Forged, changed, expired and reused continuations refuse; ordinary reads remain rate-limited. No token can be supplied through the request parser.

Append-only local migration 0089 stores immutable review evidence and hashes with owned project/wallet guards; no prior migration changed. Reads rebuild the economics contract and verify the full document hash. Cross-owner access returns 404. The approval boundary currently checks exact consent/expiry and refuses under the server-owned disabled stock signing gate. Next checkpoint adds the short authorization contract. No remote migration executed.

Verification so far: three files / 56 tests including existing quote service; TypeScript caught a fixture adapter's omitted `success` flag and the final check now uses the actual exact one-row insert count, matching existing adapters.
