# Counter Buy unsigned preparation

Source commit **c51139c** adds a fresh quote-to-packet adapter in `lib/counter-buy-preparation.ts`, using the proposal-bound ExactOut inspection from 75fb371. It is library integration; the workspace still offers pricing only. No preparation/signing API or control is enabled by this checkpoint.

## Provider contract and packet checks

Jupiter's current [v1 quote documentation](https://developers.jup.ag/docs/api-reference/swap/v1/quote) defines ExactOut amount as output atoms and documents an `instructionVersion` selector. The quote request now explicitly pins V1, versioned transactions, WSOL input, the saved proposal's token target and 50-basis-point input slippage. The existing v2 ExactIn order/signing path remains separate. Jupiter describes v1 as superseded by v2 and ExactOut support as limited to specific AMMs, so live availability cannot be inferred from these tests.

The [v1 swap contract](https://developers.jup.ag/docs/api-reference/swap/v1/swap) accepts a quote to build an unsigned transaction. This adapter obtains a fresh quote inside the preparation request, validates the retained target and explicit SOL swap-input budget, then posts only the required quote fields. Provider transaction/request IDs and arbitrary fields are not forwarded or returned. Public pricing still returns its original stripped metadata shape. Source quote metadata, route weights and fee fields needed for packet construction are checked separately.

The POST requests automatic SOL wrapping, shared accounts, v0, dynamic compute sizing, unchanged slippage and zero additional priority fee. It sets no custom payer, destination, fee, tracking or Jito account. Wrapping is requested, not yet independently verified. The adapter never signs, broadcasts, executes or calls a provider execute endpoint.

`reviewUnsignedSwapEnvelope` extracts the existing canonical envelope checks so a v1 response does not need invented v2 fee metadata. It rejects malformed/oversized packets, noncanonical encoding, unsupported message versions, wrong/additional signers and existing signatures. Existing `reviewUnsignedSwapOrder` retains its v2 metadata/fee-payer/height checks and complete return shape. The Counter adapter explicitly returns `estimatedFeesLamports=null` because rent and real fees are unknown at this stage.

Lookup-backed packets use the existing table-owner/state/slot/hash validation, after checking mainnet genesis through the caller-supplied bounded RPC interface. Table hashes and resolved addresses are retained for later simulation comparison. No RPC is contacted for a packet without lookups. Missing/wrong-network/inconsistent lookup evidence rejects the preparation.

The same packet's resolved instructions enter `reviewCounterBuyRoute`; anything other than matching declared shared v1 ExactOut fields is rejected. Quote expiry and cancellation are checked after packet construction/inspection. Provider JSON is streamed with size and UTF-8 limits; abort cancels a stalled body. The entire adapter has a thirty-second cancellation deadline, and quote I/O retains its twenty-second deadline. A supplied RPC implementation must honor its signal. Unexpected provider errors are sanitized.

All returned preparation/review records retain `executionAllowed=false` and `instructionsVerified=false`. The ledger is not mutated or consumed.

## Remaining integration

An authenticated route must bind this packet to current project/wallet revisions and source eligibility, then verify token ownership/extensions, actual SOL wrapping, fees and aggregate debits, original blockhash and independent simulation. Durable proposal-use reservations must prevent concurrent/retried approvals reusing a signal and preserve recovery after signing. Only after those checks can explicit user approval enter the existing signature/submission workflow. No client-provided quote or packet should replace this server-derived preparation. Shared strategy/session limits remain unfinished.

## Verification

- **286 tests across nine files passed**, including 22 new preparation tests, actual encoded unsigned/signed/wrong-wallet packets, lookup-backed packet evidence, cancellation/stalled-body checks, expiration, sanitized provider failures, pricing-route ownership/context/rate regressions and existing ExactIn/simulation/envelope suites. Final report: `work/release-qa/counter-unsigned-preparation-pinned-tests-20261014.json`.
- Actual-source TypeScript, five-file typed lint and production build all exited zero. Final type/build logs: `work/release-qa/counter-unsigned-preparation-pinned-types-20261014.log` and `counter-unsigned-preparation-pinned-build-20261014.log`.
- All **1,087 source hashes** stayed unchanged during final verification, digest `a3a2ed433ed96a46ef39ad3a3c6334b1620af70b1a8b132e4c0320e5d7548914`. Snapshot: `work/release-qa/source-counter-unsigned-preparation-pinned-20261014.json`.
- No rendered UI or funded/provider check applies to this library-only checkpoint. The seven authenticated route tests cover existing pricing, not a new preparation/signing route.

Claude UI/protected files, schema/history, CROP candidate, hosting, credentials and the two pre-existing whitespace edits are untouched. Tests use synthetic provider/RPC responses with actual encoded v0 packets; no live funded or provider proof is claimed. Nothing pushed, saved as a hosted version, deployed, signed or submitted.
