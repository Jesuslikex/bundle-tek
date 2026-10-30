# Helius simulator-selected bank diagnosis

30 October 2026, based on 92897cb. Read-only experiment using the existing
Helius endpoint. No purchases, provider settings, signatures or broadcasts.

## What changed in our understanding

Helius does successfully simulate a nonempty native bundle with complete
requested account vectors. It cannot be declared incapable of simulation.
However, an immediate exact-slot request for the bank it just selected failed.
This isolates the observable problem to exact-bank availability across calls,
not solely a difference between ordinary-RPC and simulator-selected slots.
Whether routing, bank retention or forks cause that is still unproven.

The existing qualification, bank/fee proof requirements, code scans, Clock,
custody, minimum, original floor and32-slot limit are unchanged. The new mode
is a standalone diagnostic; its discovery response does not admit a candidate.
No missing bank identity or independent fee proof is fabricated.

## Retained attempts

- Initial diagnostic request used an incorrect commitment JSON shape. The
  provider returned -32602, expected struct CommitmentConfig; no simulation
  succeeded. Three requests; work/jito-helius-capability-1793392801548.json.
- Corrected the explicit enum payload to
  `{commitment:{commitment:'confirmed'}}`, matching pinned Jito source.
  No changes to the slot-object format used by the earlier exact-slot probe.
- One corrected network attempt, four requests. Original confirmed floor
  463423144. Simulator selected463423145 and returned succeeded for both
  original zero-signature native transfers, with five pre and five post account
  images for each. Returned context fields were only apiVersion and slot;
  apiVersion4.3.2 is not a verified provider binary or bank/fork identity.
- Each result included a reported fee5000 and native balance metadata. Those
  simulation-reported fees are not independent fee evidence.
- Next request reused identical packet strings, blockhash and account vectors,
  explicitly selected463423145, and returned -32602 bank not found. Stopped;
  no fee/final checks were attempted, no429 and no fallback or retry loop.
  Raw: work/jito-helius-capability-1793392841525.json.

Both original response/request hash sets and identical unsigned packet binding
were independently checked. Public companion JSON contains sanitized summaries
and hashes only. Raw responses remain ignored, without endpoint/key fields.

## Scope and tests

`--live-readonly --simulator-bank` explicitly chooses the separate experiment.
Default exact-slot path remains unchanged. Seven maximum requests instead of
six for this mode only, still45seconds,1MiB per response and existing pacing.
Discovery must succeed, return both requested vectors, and be within the
original F..F+32 before an exact replay is attempted. Later floors use the
selected slot and final span still starts at F. All authority flags stay false.

Six Node24 subprocess tests run the real script with a closed mocked fetch:
default path, discovery/replay request identity, bank refusal,429, wrong exact
slot, and discovery beyond32slots. All pass; syntax, scoped lint and formatting
pass. Tests verify recorder scope and failure behavior, not economic or live
provider qualification. The first test run caught a Windows import-path issue
in the test harness; corrected with pathToFileURL, then all six pass.

## Next engineering question

A single-response design avoids depending on retrieval of a previous bank.
Our prior single-batch design already exists, but separate fee batch members
still lack independent same-bank/fork proof. Reuse it rather than rebuilding
it or treating reported fees as independent. A verified source-derived fee
calculation would need all bank-dependent inputs, and an explicit immutable-bank
identity contract is still absent. No available response has yet proved the
complete required contract. Signing and execution remain off.

Reference for request enum, not proof of the provider's deployed binary:
https://raw.githubusercontent.com/jito-foundation/jito-solana/256fbf9b601a98551636a2a394158067014f47b3/rpc-client-api/src/bundles.rs
