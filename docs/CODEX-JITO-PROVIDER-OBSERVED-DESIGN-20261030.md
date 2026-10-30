# Proposed provider-observed Jito preflight

30 October2026. Design review at4b38ed7. No implementation approval inferred;
existing strict verifier, signing gates and production callers remain unchanged.

## Proposed behavior

One explicit read-only operation gathers exact-message fee quotes and one
simulator-selected sequential bundle response from the configured trusted RPC.
It validates the response under provider trust. It does not attempt a second
simulation at the returned slot, and does not claim cryptographic bank/fork
identity across calls. No endpoint purchase is a prerequisite for the experiment.

The successful Helius native experiment is evidence this interface exists. It
is not proof that the direct swap or the entire pipeline passes.

## Flow and retained checks

1. Reuse original owned review/source binding and exact canonical transaction
   bytes. Freeze ordered packets, message hashes, ALT references, approvals and
   budget before network work. No signatures or sends in the experiment.
2. Establish genesis and original floor F. Obtain current balances, actual
   mint/Rent/pool/quote evidence and first complete program-code scan. Obtain
   independent getFeeForMessage quotes for each exact message at appropriate
   minContextSlot floors. Keep every actual context; never rename them as the
   simulation bank. Existing RPC pacing, byte/account/read budgets apply.
3. After prerequisite checks, send exactly one simulateBundle request with the
   original packets, confirmed-bank selection, signature verification disabled
   solely for unsigned research, replaceRecentBlockhash false, no overrides,
   and complete explicitly ordered pre/post account requests for each frame.
4. Admit original response binding, exact cardinality, integers and metadata.
   Require success for every packet, no replacement, complete requested images,
   exact ALT resolution, legal CPI/write scope and unchanged readonly/program
   images. Require cross-frame continuity, native/token conservation, exact
   minimums and pool price math, actual rent and reported fee within reviewed
   maximum. Require reported fee equals the independently quoted amount; no
   percentage tolerance or inferred/missing fee value. Contexts need freshness
   and floors, while their difference is explicitly retained as a trust limit.
5. Run the second complete code scan and original postflight custody/mint/Rent,
   lookup, lifetime and genesis checks. Advance floors using every admitted
   observation and enforce the original F..F+32 window throughout. Stock-only
   Clock+1 handling must not leak into Jito; all existing Jito Clock rules stay.
6. Produce a diagnostic receipt retaining wire digests, every actual context,
   exact packets, decoded transitions, separate fee observations, known failure
   stage and assurance label. Stop on429, cancellation, missing/inconsistent
   evidence or any failed guard; no automatic retry or provider/slot fallback.

## Assurance difference requiring an explicit decision

This checks separate fee amounts but does not prove their computation used the
same immutable bank as the sequential simulation. The single response's state
relationship is trusted according to the provider's implementation. It is not
proven by a slot number, TLS alone, a response hash or API version string.

It protects against detected instruction, account, fee, conservation and state
inconsistencies. It cannot authenticate a dishonest/coherently wrong provider,
guarantee later execution on the simulated bank, or universally enforce an
off-chain maximum base fee in the signed transaction. Keeping amount equality
and all financial checks does not make this equal-assurance to the strict
same-bank profile. This must be represented honestly in code, docs and review.

## Implementation boundaries

- Add a separate research entry point and DTO profile, e.g.
  `provider-observed-jito-v1`, only after explicit approval of this design.
- Reuse strict raw transport/parser, canonical decoding, lookup/account/financial
  replay and runtime collectors. If extracting shared pure checks is required,
  preserve strict entry behavior with denial regression tests.
- Do not populate strict expectedFeeLamports with simulation.fee, forge a pinned
  request, convert different contexts into a same-bank observation, or reuse a
  strict proof type that asserts provenance this profile cannot provide.
- No app route, environment switch, signing button or submission caller selects
  this research profile. All providerQualified, bankIdentityVerified,
  signingAllowed and executionAllowed authority remains false.
- Existing strict profile and custom synchronized-validator prototype stay
  available for actual future same-bank evidence. Do not replace their tests.
- Preserve other agents' recovery-password drafts and all protected UI files.

## Verification before any later signing work

Adversarial tests must reject packet/context/order substitution, missing or
reordered images, changed readonly/CPI/code/ALT scope, wrong token units or rent,
cross-frame discontinuity, fee mismatch/over-cap, worsened minimum, stale or
wrong Clock, invalid lifetime, F+33, cancellation and429. Test that differing
fresh contexts are explicitly labelled and cannot enter the strict API.

Then run a fixed bounded unsigned direct-Ray­dium sample with every outcome
retained, both code scans and every original guard. Establish repeatability,
not a favorable isolated sample. Separately verify owned API/UI review and
recovery before proposing any signing integration. No funded test, deployment
or release permission is granted by these steps.

## Decision requested

Approve or decline building this separate unsigned research profile with the
explicit provider-trust limitation above. Prior "don't loosen checks" remains
in force; review acknowledgement alone does not authorize replacing the strict
bank-provenance requirement. No purchase or signing activation is needed for
the proposed research step. Authorized provider engineering inquiries may
proceed independently; their replies are not yet verified.

Documentation-only checkpoint. Source inspection and diff checks only; no
tests, live RPC, application edits, deployment, signing or trades in this step.
