# Single-response fee evidence audit

30 October 2026. Read-only source audit after 6de3166; no live RPC request,
application edit, purchase, provider setting, deploy or wallet action.

## Candidate examined

Can complete account images from the successful Helius simulateBundle response
replace the separate fee/bank calls without weakening the current verifier?
The successful native discovery supplies all requested images and simulation
reported fees, but its bank is unavailable to the immediate exact-slot replay.

## Source result

Inspected the Agave v4.3.2 bank source because the captured API reports4.3.2,
and compared the previously pinned Jito implementation. Neither version label
nor source inspection attests to Helius's actual deployed binary.

In the downloaded v4.3.2 runtime/src/bank.rs, get_fee_for_message at3385..3404
checks recent-blockhash/nonce availability, then obtains transaction configuration
using the bank feature set. Fee calculation uses the bank's fee_structure
lamports_per_signature and derived priority fee. The recent-blockhash queue's
fee value is not the scalar passed into calculate_fee there. Therefore simply
fetching the deprecated RecentBlockhashes sysvar and multiplying its value is
not established as an equivalent replacement. fee_structure() at6594..6596
returns a bank member, not one of the five account images captured by our probe.

The pinned Jito fee crate separately computes signature charges and adds the
priority fee. It does not establish those input values for a remote provider.
Hardcoding5000 because this native sample reported5000 is not independent proof
of the exact current bank configuration for a complete swap bundle.

References:

- https://raw.githubusercontent.com/anza-xyz/agave/v4.3.2/runtime/src/bank.rs
- https://raw.githubusercontent.com/jito-foundation/jito-solana/256fbf9b601a98551636a2a394158067014f47b3/runtime/src/bank.rs
- https://raw.githubusercontent.com/jito-foundation/jito-solana/256fbf9b601a98551636a2a394158067014f47b3/fee/src/lib.rs

## Existing work reused, not rebuilt

lib/jito-coherent-prefee-attempt.ts already implements the experimental single
batch collector; separate batch members do not prove identical immutable bank.
lib/jito-fee-batch.ts binds independently requested fees to exact messages.
lib/jito-same-bank-prototype.ts and its loopback transport already implement
the research envelope for the custom validator method, including packet hashes,
bank hash and independently computed fees. The local source prototype exists;
it lacks a synchronized trusted operator/endpoint. A self-reported bank hash
alone is not such trust. No adapter or requirement was replaced in this audit.

## Completion audit

- Direct Raydium source match and bounded archive research: retained prior
  evidence, not rerun or claimed as full qualification here.
- Existing Helius nonempty native simulation: fresh prior-turn evidence yes.
- Requested native pre/post vectors: fresh prior-turn evidence yes.
- Complete direct swap on Helius: missing; native success does not prove it.
- Reliable exact bank retrieval: contradicted by fresh Helius attempts.
- Independent fee and immutable-bank evidence: missing from captured response.
- Unchanged source/Clock/custody/minimum/rent/code-scan/freshness checks: preserved.
- No signing/send/deploy/purchase: preserved.
- Overall read-only full-swap qualification: NOT achieved.

## External dependency and next admissible action

This is the third consecutive resumed goal turn with the same missing upstream
bank/fee contract: ordinary-Helius probe, simulator-selected-bank diagnosis,
and this source-derived-fee audit. New evidence narrowed the cause but did not
remove that dependency. No further equivalent retries are justified.

A solution still needs a synchronized endpoint offering the complete custom
contract under a verified trust boundary, or a provider exposing equivalent
evidence. Obtain demonstration/technical confirmation before paying; changing
plans alone is not a solution. The user has prohibited purchases and previously
declined provider contact, and has no dedicated validator. Those boundaries
are respected. No currently accessible endpoint is verified to provide the
required evidence. The goal is blocked, not complete, pending that external
capability or explicit new direction. Signing remains off.

Documentation-only checkpoint. No tests rerun; previous six recorder tests and
119 parser/frame tests remain their stated prior verification scopes.
