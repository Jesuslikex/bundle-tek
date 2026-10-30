# Jito trust model review and decision proposal

30 October2026, source checkpoint95c35a2. Review only, requested after the user
asked why provider emails were necessary. No application/policy/provider setting
changes, new RPC, signatures, submissions, purchase or deployment.

## Existing requirement and purpose

lib/jito-bundle-simulation-frames.ts requires expectedFeeLamports independently
of a simulation's fee; it compares exact fees and applies maximumFeeLamports.
lib/jito-fee-batch.ts binds actual getFeeForMessage observations to exact message
hashes. lib/jito-coherent-prefee-attempt.ts requires fee contexts matching the
simulation slot, while its documented batch profile does not prove immutable
bank identity. The custom prototype adds independent fee calculation on one
bank reference plus packet/bank hashes, with deployment trust still separate.

This protects the coherence of our preflight evidence and catches mismatched
fees, changed snapshots and unsupported provenance claims. It does not freeze
mainnet until execution. It does not independently authenticate a dishonest RPC:
both RPC fee and simulation results still originate at a trusted service unless
an additional verifiable execution mechanism is established.

lib/jito-readonly-qualification.ts explicitly returns fullProviderQualification
false even when local checks pass. Provider qualification must not be inferred
from local parser or replay success. Current submission gates remain closed.

## What standard interfaces provide

Jito documents submitting up to five ordered signed transactions with bundle
atomicity under its execution model; its documented submission interface does
not make our custom same-bank fee attestation a prerequisite. Standard
getFeeForMessage offers commitment and minContextSlot, not a bank-hash selector.
Thus paying for standard RPC throughput cannot establish our extra contract.

Sources inspected today:
- https://docs.jito.wtf/lowlatencytxnsend/
- https://solana.com/docs/rpc/http/getfeeformessage
- https://solana.com/docs/rpc/http/simulatetransaction

The actual existing Helius native discovery succeeded with full requested
images; exact replay of its selected slot failed. This demonstrates useful
simulation access but not a direct-swap qualification or bank/fee attestation.

## Options

### Retain the current strict profile

All existing gates remain. Need the verified custom synchronized endpoint or
equivalent provider evidence. Engineering inquiries are sent. This offers the
current specified preflight coherence, with the known external dependency.

### Proposed separate provider-trusted profile

Potentially use a single simulator-selected bundle response for all sequential
pre/post account transitions, and separately observe exact-message fees with
freshness floors, compare amounts and enforce the user's reviewed budgets.
Preserve packet identity, ordering, exhaustive instruction/CPI/write scope,
mint/pool/Rent and custody replay, both full code scans, minimum outputs, Clock,
original32slot window, blockhash lifetime, fresh explicit approval, browser-only
signing, one send and durable receipt recovery.

This accepts the provider's single-call simulation semantics under a clearly
stated HTTPS/provider trust boundary. It would not claim cryptographic bank
identity or that the separate fee call used the same immutable bank. It is a
different assurance profile, not an equally strong proof of the original rule.
Do not manufacture a strict-profile success or set fullProviderQualification
true. No new profile has been implemented or approved here.

Before this option can be built, review the precise threat model and downstream
consumers with the user. Independent accounting within one provider response
can detect inconsistent data but does not authenticate provider execution.
Off-chain reviewed fee budgets are not transaction-enforced fee caps. Compute
budget instructions bound priority parameters; they are not a universal cap on
all runtime base-fee changes. Any proposed protection must describe this limit
and cannot promise a future execution bank matches the simulation bank.

## Recommendation and boundary

Keep the present strict implementation intact while awaiting the two authorized
engineering replies. If the user's product goal is ordinary user-approved Jito
bundling on existing RPC, propose and explicitly approve the alternative trust
profile instead of continuing to imply that specialized attestation is a Jito
protocol requirement. Do not build this alternative under the earlier instruction
"don't loosen checks" without a clear user decision on the assurance change.

Neither profile is newly qualified by this review. Existing direct Raydium
research remains partial; native success is not a swap/production/funded test.
No equal-assurance solution on currently accessible standard interfaces has
been established. This checkpoint is a design review, not an execution release.
