# Opt-in single-batch collector

The prefee collector accepts explicit singleBatch: true. Defaults remain the
two-request path. Separate getFeeForMessage results must match the simulation
bank and expected fees, within the original window. The raw reader explicitly
labels and binds the actual confirmed-commitment request. It never fabricates
an exact-slot wire request for this mode. All existing frame checks remain.
The option grants no provider, source, signing or execution authority.

Verification: 107 tests across the prefee collector and raw response parser
pass; whole-project tsc --noEmit exits zero. New cases cover one-request binding,
independent fee-bank mismatch and fee disagreement. Existing default-path tests
remain passing.

One attempted fixed Alchemy campaign received a nonempty batch but stopped in
the existing recorder, which expected a separate exact response. It is retained
as setup-or-transport-failed, not a successful campaign. No replacement live
campaign was run. Exact retained-request offline replay against the compiled
collector returned captured, one read, requestBound true, providerQualified false.
The private evidence directory is
work/release-qa/jito-alchemy-single-batch-20261029-1793235830447/.

Still required: recorder support for derived simulation-member provenance,
expanded adversarial and cancellation coverage, and a fixed complete Alchemy
sample. This is not repeatability or full-swap qualification. Jupiter artifact
verification remains open. No pins, production submit gates, deployed settings,
credentials or hosted schema changed. Zero signatures and broadcasts.
