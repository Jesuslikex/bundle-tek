# Provider bank identity and Jupiter verification

Read-only documentation review, 29 October 2026. No endpoint, credential,
program policy, signing, submission, deployment or hosted state changed.

Alchemy and QuickNode document Jito bundle simulation. Neither inspected page
states that separate getFeeForMessage and simulateBundle members of a JSON-RPC
batch use the same bank instance or identifies that bank's fork. QuickNode
documents simulationBank selection, but this is not a guarantee about a separate
fee call. Solana's getFeeForMessage documentation exposes minContextSlot, not
an exact bank hash selector. Alchemy's retained sample had mixed numeric slots
in two of three batches. Matching numeric slots are necessary but not sufficient
evidence of identical bank/fork identity. No provider is qualified by this review.

References:
- https://solana.com/docs/rpc/http/getfeeformessage
- https://www.quicknode.com/docs/solana/simulateBundle
- https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/simulate-bundle
- https://github.com/jito-foundation/jito-solana/blob/master/rpc-client-api/src/bundles.rs

Provider confirmation needed: can a single request return independently
calculated getFeeForMessage-equivalent fees, full ordered bundle simulation
and pre/post account data from one immutable bank, with an identifiable bank
or fork and explicit semantics, without slot substitution? If so, establish
the contract, plan restrictions, limits, and verify with adversarial and live
read-only samples. A self-operated or dedicated Jito-Solana node with a custom
atomic endpoint is a possible engineering approach, not an existing product
or a verified solution. Do not infer this guarantee from an endpoint or plan.

The public Jupiter verifier returned HTTP 200 with is_verified false and empty
on_chain_hash, executable_hash, repo_url and commit on 29 October. Jupiter's
official audit index links v6 reports, but does not link the inspected program
bytes to their audited source. Solana's verification guidance describes source,
build and on-chain hash comparison; an audit alone does not establish that link.
An authoritative source/build attestation or equivalent review is still needed.
Unverified is not evidence the program is unsafe. The pinned policy remains.

- https://developers.jup.ag/docs/resources/audits
- https://solana.com/docs/programs/verified-builds
- https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4

No live qualification or full swap success is claimed. Submission stays gated.
