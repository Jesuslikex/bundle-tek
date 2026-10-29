# Jito bank source trace

Read-only review on 29 October 2026. The public Jito-Solana master revision
resolved through GitHub's API to 256fbf9b601a98551636a2a394158067014f47b3.
The inspected pinned source is:
https://github.com/jito-foundation/jito-solana/blob/256fbf9b601a98551636a2a394158067014f47b3/rpc/src/rpc/bundles.rs

At lines 90-96 it resolves a single bank for the simulateBundle invocation.
It uses that bank to sanitize the supplied transactions, calls its sequential
simulation with the requested account snapshots, maps each simulation result's
fee and account data into the response, and constructs the response with the
same bank reference (lines 140-165 and 194-247). This supports the internal
relationship of fields in that upstream implementation. It is not evidence
that Alchemy runs this commit, that a separate getFeeForMessage call shares
the bank, or that the returned slot identifies a fork across independent calls.

A possible custom validator endpoint could obtain one bank reference, calculate
independent message fees on that same reference, and perform bundle simulation
with it before returning an evidence envelope that binds exact request bytes,
bank identity, fee and simulation outputs. This requires implementation,
source review, deployed-build verification, failure tests and an operator or
provider able to serve it. A backend assertion alone is not cryptographic proof.
No existing Alchemy or QuickNode API is claimed to provide this endpoint.

Jupiter's public verifier still returned unverified, with empty on-chain and
executable hashes, repository and commit in the 29 October lookup documented
in CODEX-JITO-PROVIDER-BANK-CONTRACT-20261029.md. That is an absence of a usable
verification record, not proof the program is unsafe. The source/build link for
the observed Jupiter image remains unavailable. No policy pin was modified.

No actual implementation, provider qualification, funded test or deployment
is claimed by this source trace. All submission gates and checks remain in place.
