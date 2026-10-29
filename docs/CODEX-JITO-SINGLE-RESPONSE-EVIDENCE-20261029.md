# Single-response Jito evidence candidate

29 October 2026, offline inspection of the retained Alchemy attempt 3 exact
response at context slot 462684694. No new provider request or policy change.

Both transaction results include fee, preBalances, postBalances,
preExecutionAccounts, postExecutionAccounts, loadedAddresses, preTokenBalances
and postTokenBalances. Each fee is 5000 lamports. The payer's balances are
39231156350 -> 39231151350 -> 39231146350, consistent across the two sequential
transactions. These are native zero-value transfers, not swap evidence.

This is a concrete candidate for avoiding the discovery-to-exact-bank race:
validate the fee and complete before/after state from one simulation response.
Upstream Jito's response type includes these fields:
https://github.com/jito-foundation/jito-solana/blob/master/rpc-client-api/src/bundles.rs
This mutable upstream reference is schema guidance, not a deployed-version proof.

Before implementation can replace any existing check, establish independent
fee expectations for the exact messages, validate complete account ordering and
loaded addresses, and prove the reported fees agree with raw account changes
and every existing custody/economic bound. Preserve the original freshness
window, Clock checks, both code scans, exact packet bytes, signature checks and
no replacement blockhash. Reject missing, contradictory or malformed fields.
Do not simply trust the provider fee field or remove the current fee guard.
The candidate is not yet an implemented or qualified replacement.

## Artifact recheck

Recomputed from ignored jito-program-review-20261025 files:

- Token-2022 full image: 1382016 bytes, SHA256
  15a2e615a42e20f31714bbaaee43002ae6f1cda2e8d7118243117ab3c1342e2d.
- Retained official v11.1.0 image: 611056 bytes, SHA256
  3dde54d202caa2d10514fd58a154df5f26f07643f9f5fd0402ff08084f0cb954.
- Byte comparison confirms the full Token-2022 image equals that entire release
  image followed only by zeros. This rechecks local correspondence, not today's
  deployed state, release authenticity or an independent reproducible build.
- Jupiter: 2892224 bytes, SHA256
  0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30.
  It still differs from the current reviewed policy hash. Its exact source/build
  provenance remains unresolved; no pin replacement is made.

No full-swap qualification, signing authority, deployment or funded test is
claimed. Existing refusal behavior and the draft submission block remain.
