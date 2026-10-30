# Provider shortlist: evidence required before purchase

30 October 2026. Public primary documentation reviewed after f0659aa.
No provider contacted, account created, subscription purchased, setting changed,
RPC sent, deployment or funded action. No application checks changed.

## Findings

| Provider | Documented capability | Exact contract proved? | Decision |
| --- | --- | --- | --- |
| QuickNode Lil' JIT | simulateBundle, simulationBank, pre/post account configuration | No independent same-bank fee or immutable-bank contract established | Do not upgrade on this evidence |
| Triton | Jito bundle simulation and bank selector | No independent fee computation or immutable-bank identity in inspected response type | Technical confirmation/demo needed |
| 1inch Web3 RPC | Solana simulateBundle; documentation describes a vendor-owned QuickNode Lil' JIT payload | No; not demonstrated to be an independent implementation that fixes this gap | No purchase or integration justified |
| RPC Fast dedicated/custom clusters | Custom software/plugins advertised; managed node setup and testing | No explicit same-bank fee method or deployment attestation documented | Candidate to ask about hosting existing custom method, not a qualified endpoint |
| Shyft dedicated | Dedicated RPC and automatic backup-cluster failover | No exact required contract found on inspected RPC page | Dedicated label alone insufficient |

The 1inch response schema explicitly admits vendor-owned additional properties;
its documented context includes slot/apiVersion, not an immutable bank identity
and independently computed message fees. This does not prove extra fields are
impossible, only that they are not a usable documented guarantee.

RPC Fast's dedicated page advertises starting at $2200/month. Its separate free
shared plan does not establish access to custom validator software. Not an
economical recommendation for this project based on currently verified facts.
Custom hosting support for our actual patch remains an inference to confirm.
Do not extrapolate customization marketing into proof of compatibility.

## Acceptance requirements for a provider demonstration

Reuse the existing reviewed prototype and adapters. Require one operation to:

1. Retain one immutable synchronized mainnet bank reference for the operation.
2. Independently calculate the fee for each exact serialized message using
   that reference, separately from the simulation-reported fee field.
3. Sequentially simulate the exact ordered bundle on that same reference and
   return every requested pre/post account image, including unchanged accounts.
4. Bind packet/message hashes, selected slot, bank/fork identity and fees to
   the actual request; refuse replacement blockhashes, overrides, missing images
   and ambiguous or unavailable banks, without fallback or automatic retries.
5. Provide the implementation/deployment and authenticated transport basis
   for trusting those assertions. A bankHash string by itself is insufficient.
6. Allow read-only unsigned demonstration before payment and permit our
   unchanged 32-slot, Clock, custody, minimum, rent and two-code-scan checks.

Both positive samples and adversarial refusals must be retained. Native-only
success is not full swap qualification. No signing gate can be enabled by this
documentation review or a sales assurance alone.

## Unsent technical inquiry

For RPC Fast custom infrastructure or Triton engineering, if user later
authorizes contact:

> Before any purchase, can you demonstrate a Solana mainnet RPC operation that
> holds one immutable bank reference, independently computes getFeeForMessage-
> equivalent fees for exact serialized messages, and sequentially simulates
> their Jito bundle using that same reference, returning all requested pre/post
> images including unchanged accounts? We require exact packet binding, bank/
> fork identification, no blockhash replacement or account overrides, and an
> explainable authenticated deployment/trust boundary. Can your service expose
> this today, or host a reviewed custom Jito-Solana method? Please supply the
> schema/source basis, unsigned read-only demo access, limitations and price
> before we commit. Standard simulateBundle plus independent JSON-RPC batch
> members with equal slot numbers does not satisfy this requirement.

No message has been sent. User's earlier refusal of provider contact remains
in force. No currently accessible provider is proved qualified by this review.

## Primary sources inspected

- https://www.quicknode.com/docs/solana/simulateBundle
- https://docs.triton.one/trading-apis/bundle-simulation-with-jito
- https://business.1inch.com/portal/documentation/apis/web3/solana/methods/simulateBundle
- https://rpcfast.com/dedicated-solana-nodes
- https://rpcfast.com/pricing
- https://docs.rpcfast.com/solana-dedicated-nodes/sla-for-solana-dedicated-node
- https://docs.shyft.to/solana/shyft-rpcs

Documentation-only checkpoint; no tests run or live provider qualification
claimed. Prior supporting tests retain their original scope. Preserve the
three unrelated recovery-password drafts and draft-branch release hold.
