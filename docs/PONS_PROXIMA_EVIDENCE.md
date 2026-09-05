# Proxima/Pons backend: evidence and capability boundaries

Observed UTC: 2026-09-05T15:03:21.111614+00:00

## Sources and method
- Public client: https://app.proxima.tools/assets/index-B-FdtPJt.js
- Asset SHA-256: `904a042f283589f4fe76af3cb1bc5eef12d0514104655f2fe440db7be1e11533`
- Launch UI: https://app.proxima.tools/launch/create/launchpad
- Pons documented integration: https://docs.ponsfamily.com/v2
- Pons launch site: https://www.ponsfamily.com/launchpad

The public JavaScript was retrieved with HTTP GET (200). No Proxima write endpoint, private-key export, wallet connection, signature, or launch operation was invoked. This report describes observable client contracts, not recovered private server code. Code was not copied into PulseForge.

## Material observations

| Observable client behavior | What it establishes | What it does not establish |
|---|---|---|
| Commands/queries for launch-plan update, metadata, funding expected/required, and rescue funding | A server-managed workflow rather than a static launch form | Server durability implementation, concurrency correctness, or security |
| `get-mev-contract` and `rescue-mev-contract` client routes | A launch-specific MEV contract workflow is represented in the client | Its address, bytecode, relay, implementation, or delivery guarantee |
| Pons exposes Block-0, staggered, manual launch modes | Client offers different execution strategies | Verified same-block or atomic execution |
| Pons V2 override disables multi-launch | Current client distinguishes V2 from general Pons multi-deploy support | V1/V2 protocol equivalence |
| Pons warning says deployment can remain when buys revert after front-running | The advertised buy protection is not necessarily atomic token deployment plus purchase | Exact revert and refund semantics of server contracts |
| Wallet and funding endpoints have estimate, execute, status, cancel/rescue concepts | Funding lifecycle and recovery are product features | Permission to access any account, hold keys, or execute transfers |

Pons' public `launchAndBuy` router is a separately documented single-transaction path. A fork proof of that router must not be presented as proof of Proxima's separate MEV workflow.

## PulseForge implementation acceptance gates

1. Persist immutable owner-scoped intents and audit events with idempotency and payload collision rejection.
2. Lease simulation work with revision/CAS protection; never let a stale worker overwrite newer state.
3. Read chain ID, bytecode, eligibility, launch economics, balance and nonce; pin state reads and return provenance.
4. Build native-ETH V2 launch-and-buy calldata with explicit recipient, quote-in, fee ceiling, minimum output, salt and declared exemption list.
5. Execute real read-only RPC simulation and return an expiring unsigned envelope. Nonce is a snapshot, not reserved.
6. Do not implement a mainnet broadcast path without a separate explicit wallet approval surface and spending review.
7. Associate a supplied transaction hash only after checking its exact from/to/value/input against the job; receipt success alone does not prove the correct launch.
8. Independently execute the protocol on an isolated pinned Robinhood fork and prove failure rollback, then exercise the actual production planner against it.
9. Test actual Workers/D1 routes and persistence, owner isolation, request bounds, retries and expired simulations. Fixtures and real execution evidence must be labeled separately.

## Not delivered by a single-recipient router integration

Independent multi-wallet signing/submission, private relay/sequencer integration, Proxima MEV-contract parity, automatic funding/selling, full-supply acquisition guarantees, or mainnet execution readiness. Supply distribution is not equivalent to independent wallet purchases. No concealed coordinated ownership, holder fabrication, or artificial trading volume is part of this backend.
