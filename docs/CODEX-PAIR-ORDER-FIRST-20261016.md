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

## Step 3: Claude's market-bound correction

Supersedes step 1's independent-source and improvement-acknowledgement wording. The initial preview is explicitly another Jupiter reading. Only a deterioration strictly above 2% requires the additional acknowledgement; improvements are shown without blocking.

The new saved-market comparison reads the same `imported_market_observations` collection used by the stats strip. It takes the latest observation and its default first/highest-liquidity pool, with the exact pool IDs and timestamps displayed. A user-selected alternate chart pool is not passed into the Codex-owned wallet panel, so this does not claim to mirror an alternate UI selection. Both base and exact quote-asset USD observations must be current revisions, at most five minutes old, not future-dated and in matching unscaled token UI units. Quote-asset USD conversion uses its saved price, never an assumed stablecoin peg. Scaled-token feeds lack unit provenance, so comparison is explicitly unavailable there. Missing/stale/priceless/nonmatching evidence produces an on-screen reason, not a fabricated zero difference.

Expected order-implied base USD price is input/output times quote USD for buys, output/input times quote USD for sells. Exact rational cross-products decide worse-than-2%; rounded display never controls acknowledgement. The immutable review binds both comparisons. An available market reference shortens expiry to its five-minute boundary. Either worse comparison can require the extra consent; neither overrides the fresh Jupiter minimum or absolute floor.

Verification: 18 market-bound tests (buys/sells, improvements, exact boundaries, micro prices, non-peg conversion and unavailable reasons) plus 20 review-contract tests pass. No provider requests or hosted changes.

## Step 4: guarded short authorization and API

The authenticated same-origin, bounded UTF-8 JSON API accepts only explicit prepare/approve actions. It returns a public review with no packet material; extra fields cannot select a qualification policy. Exact expiry/hash/minimum/acknowledgement validation precedes authorization. Fresh saved market comparison must still match the immutable review. Preparation now binds the owned saved context across the complete review; authorization compares it with the original and again after runtime reads.

The server release gate remains hard-coded false. Even if it were changed, today's runtime still returns false for trusted-program policy and application reservations, independently preventing an authorization. No frontend signer, unlock, send or automatic retry is connected. Do not describe the disabled path as operationally qualified.

The internal authorization contract requires original packet and account-snapshot identity, owned context/proof, fresh custody/balance/lifetime, both complete matching code scans, trusted policy, reservations and the unchanged original 32-slot ceiling. Its five-second budget begins at server approval; rechecks consume that budget, and a slow check refuses. It never renews an expired review or replaces its packet/lifetime. The future browser-window validator checks exact identity and expiry immediately before any local signer. This validator is a binding/expiry check, not server authenticity or a single-use signing claim by itself; that later signer/claim remains unreleased behind the gate.

Local migration 0090 permits at most one immutable authorization per review, exact owned consent, non-submission scope and an integer-millisecond maximum of 5,000 ms. A test exposed SQLite floating Julian-day tolerance at 5,001 ms; the integer SQL guard now rejects it. Current 35 tests across service, authorization and API pass. The pair digest's Buffer-to-hex conversion was replaced with identical browser-safe byte formatting; trace regressions are included in final verification. No old migration or group production file changed; 0089/0090 remain unapplied remotely.
