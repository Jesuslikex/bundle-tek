# Same-bank research adapter and Jupiter evidence, 29 October 2026

## What was built

The Linux validator prototype now returns ordered SHA-256 hashes of the actual
serialized transaction packets (as base58), alongside its frozen-bank hash,
independently calculated fees and simulation result. It still rejects blockhash
replacement and simulation/fee disagreement. The exact source patch is
`patches/CODEX-JITO-SAME-BANK-PROTOTYPE-20261029.patch` against Jito-Solana
revision `256fbf9b601a98551636a2a394158067014f47b3` and its two pinned Jito
protocol submodules.

`lib/jito-same-bank-prototype.ts` is an isolated research response adapter. It
reconstructs the expected exact request, parses a bounded raw response, checks
its ID and bank slot within the original 32-slot limit, compares ordered packet
hashes and independent fees, and passes a clearly marked derived projection
through the existing raw-frame verifier. It preserves the original response.
The caller must separately establish that the expected request is the actual
transport request. A bank hash and packet hashes are server assertions, not
independent attestation. The adapter always marks bank identity, provider,
source, signing and execution unverified/false. It is not wired to any API,
provider configuration or execution path.

## Verification

- The updated patched validator executable built in Ubuntu WSL2; the local
  debug binary SHA-256 is `d95315396bcef038088fd8cc75e3c622be0332ecd5704c60661df957ff4e0b3a`.
- All 7 Jito validator bundle RPC tests passed, including same-bank, packet-hash,
  replacement and size refusals.
- The adapter and existing simulation response/frame files passed 174 tests in
  3 files. Tests cover request, packet order/hash, fee, bank, slot, frame and
  duplicate-JSON refusal. Whole-project `npm run typecheck` and scoped oxlint pass.
- This is synthetic local testing. There was no live endpoint, trusted transport
  verification, live full-swap qualification, real wallet action or deployment.

## Jupiter and remaining blockers

The public `https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
returned `is_verified: false`, with empty executable hash, repository and commit.
The retained local Jupiter file rehashes to
`0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30`, differing
from Bundle's `099da3a26d336aa7174960f057546f192fc1ccda8e3e9d1b4aa5c69fa8a79a5f`
pin. This is historical retained evidence, not a fresh atomic on-chain capture.
The mismatch and public verifier result do not independently prove the current
on-chain binary, identify its source or justify a new pin. Other route programs
and the timing budget remain subject to their original checks.

A full qualification requires a trustworthy, synchronized validator with bounded
read-only transport and actual request binding, integration across the existing
runtime and fee evidence path, independently reviewed Jupiter binary provenance,
and a fresh full-swap run that satisfies every existing check. The diagnostic
adapter does not supply those things; it must not be used to bypass them.
No checks, production settings, credentials, signing gates, hosted database or
release state were changed.
