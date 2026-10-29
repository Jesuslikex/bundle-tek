# Jupiter upgrade-buffer observation and validator capability

29 October 2026. This is provider-reported, read-only evidence. It is not
source verification, a security audit, a same-bank proof, or a Jito
qualification. No transaction was signed or broadcast.

## Historical buffer

The public Solana RPC reported a successful upgrade transaction at slot
459479624. The parsed loader instruction names Jupiter v6, its ProgramData,
staging buffer `CbboLZHpRP8LTWmn3Wj2DGCya1rVvZX6ARMJs5k76n6n`, and upgrade
authority `CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ`. The existing Alchemy
account's [historical account API](https://www.alchemy.com/docs/solana/account-archive)
returned the buffer at the preceding slot, 459479623. Its owner, Buffer tag
and buffer authority match the expected loader/upgrade record. After excluding
the 37-byte buffer header, the reported 2,036,392 bytes hash to
`c0c0ce1c15b0eab3c8b81eacb25cb4895d8ba861a1b0125940609ac6ac064ae2`.
Zero-padding these bytes to the 2,892,224-byte currently reported ProgramData
code length yields `0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30`,
the same hash returned for the latest code by the public RPC. The sanitized
computed results are in `CODEX-JUPITER-UPGRADE-OBSERVATION-20261029.json`;
raw RPC bodies were not retained. `scripts/jito-jupiter-upgrade-history.mjs`
repeats the bounded read-only sequence using `SOLANA_HOLDER_RPC_URL` from the
caller's environment without printing that URL or provider response bodies.

The evidence links a provider-reported pre-upgrade buffer to a provider-reported
upgrade transaction and current code. Neither RPC is independently authenticated,
transaction signatures were not independently verified, and the slot-before
snapshot does not by itself exclude a same-slot buffer change before the upgrade.
No full buffer-write history was reconstructed. Matching bytecode does not
identify source, prove source-to-binary reproducibility, or assess security.
The current full-code hash still differs from Bundle's approved pin. No pin
or program policy was changed.

## Validator endpoint probe

A read-only request to the existing Alchemy endpoint returned `getHealth: ok`
and a confirmed slot. A near-simultaneous public RPC slot was two ahead
(Alchemy 462753066, public 462753068). This single observation is neither
sustained synchronization proof nor proof of a shared bank/fork.
An empty, non-financial request for the prototype custom
`simulateBundleWithSameBankFees` method returned HTTP 400 and JSON-RPC -32600.
That probe does not establish that the custom method is available or that any
fee and simulation use the same bank. Existing Alchemy `simulateBundle`
availability must not be confused with the custom evidence API. No provider or
credential setting was changed.

The user has confirmed no suitable dedicated server is currently available.
Without an authenticated, synchronized endpoint implementing the custom method,
reviewed runtime integration and Jupiter source/build evidence, the full
read-only swap qualification remains unrun. The original 32-slot, fee, code,
custody and signing checks remain unchanged. No deployment or funded test.

## Validation

Thirteen historical-observation tests cover matching bytes and refusals for
changed signatures, slots, authorities, buffer links, duplicate upgrades,
invalid loader/account data and changed deployment slot. Together with the
existing public-code and verification-PDA tests, 33 tests pass; scoped lint
passes. These are synthetic tests, not independent provenance or live swap proof.
