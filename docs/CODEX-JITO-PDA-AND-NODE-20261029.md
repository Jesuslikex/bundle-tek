# Jupiter verification-metadata probe and validator access

29 October 2026. This is diagnostic, read-only evidence, not a completed source
verification, same-bank qualification or release.

## On-chain verification metadata

The official `list-program-pdas` implementation in
[solana-verifiable-build](https://github.com/solana-foundation/solana-verifiable-build/blob/26ba8211eddbfab49d30826d15a2408332b89543/src/solana_program.rs#L509)
queries the Otter Verify program with a memcmp filter at byte offset 8 for the
target program ID. `scripts/jito-jupiter-verify-pda.mjs` reproduces that
read-only filter against the public Solana RPC, with a 40-byte data slice,
checks of account owner, target bytes, response shape and bounded responses,
and a positive-control query for the documented verified Phoenix program.
`CODEX-JUPITER-VERIFY-PDA-20261029.json` records the computed results; raw RPC
bodies were not retained. The two queries are separate and are not same-bank
proof. The provider alone is trusted for neither completeness nor correctness.

At 04:47 UTC the Jupiter query returned zero matching accounts at context slot
462751491; the Phoenix control returned 14 at 462751492. The control shows this
particular query worked for one known program at that time. A separate
PublicNode request refused with HTTP 403. This is evidence that the first RPC
reported no matching Otter Verify records, not proof that no record exists on
all providers or that another verification mechanism cannot exist. The
[public verification API](https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)
previously reported unverified with empty source and executable fields. The
2025 [audit listed by Jupiter](https://developers.jup.ag/docs/resources/audits)
contains a scope revision, but we have not established that revision built the
current deployed bytes. No executable pin or signing rule changed.

The evidence needed to resolve this through a reproducible build is an
accessible exact source repository and deployment commit, build toolchain and
features, and a deterministically produced artifact matching the current onchain
program. The reference workflow is [Solana's verified-build guide](https://solana.com/docs/programs/verified-builds).
An owner-published attestation or current audited artifact would also require
independent validation and policy review; a program ID or two matching provider
reads is not sufficient. No external message was sent.

## Validator access

Julian confirmed he does not have an existing suitable validator or dedicated
server. The local PC is below [Anza's hardware guidance](https://docs.anza.xyz/operations/requirements)
as recorded in `CODEX-JITO-LOOPBACK-READINESS-20261029.md`. The DediPeak D48
candidate and its estimated cost and unverified operational details are in
`CODEX-JITO-NODE-AND-JUPITER-20261029.md`. It is not provisioned, synchronized,
or verified to run the custom same-bank endpoint. No paid service was ordered.
Even a synchronized node would not itself resolve Jupiter source provenance.

## Validation and scope

The new parser's nine synthetic tests and scoped lint pass. The live probes did
not sign, send or fund transactions. The full Jito swap qualification was not
run because no authenticated synchronized endpoint or reviewed Jupiter binary
is available. No check, code pin, signing gate, deployment, provider setting or
production database changed.
