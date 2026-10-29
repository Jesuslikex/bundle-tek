# Jupiter upgrade signature evidence and external information needed

29 October 2026. This is read-only evidence, not source verification or full
Jito qualification. The prior buffer and provider limits remain in
`CODEX-JITO-HISTORICAL-BUFFER-20261029.md`.

The public Solana RPC returned the serialized transaction for the recorded
Jupiter upgrade. `scripts/jito-jupiter-upgrade-signatures.mjs` decoded its
message and checked each required Ed25519 signature against the exact message
bytes using Node's cryptographic verifier. The transaction's first signature
matches the requested public signature. It had one required signature; the
message hash is `bb7c964b3efa6dc5bccf5fcf298fbfeb154a47865a50921b43b6e411a1532fa6`.
The sanitized result is in `CODEX-JUPITER-UPGRADE-SIGNATURE-20261029.json`.

This verifies that the signed message bytes correspond to the signer and
signature. It does not independently establish inclusion, execution success,
inner instructions, the RPC-reported slot or canonical fork. Nor does it link
Jupiter's executable to source. No executable pin, provider or signing gate is
changed. The verifier makes one public read-only request and does not use a
user wallet. Tests sign only locally generated synthetic test data.

## Prepared questions, not sent

The blockers require information or access not available in the current
checkout. No support request or message has been sent.

### Jupiter developer support

Official support entry: https://developers.jup.ag/support

> For the mainnet Jupiter v6 aggregator
> `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, can you provide an
> authoritative source repository, exact deployed source revision, build
> toolchain and build parameters, or a signed release artifact and independent
> verification procedure for the deployment at slot `459479624`? We observed
> full padded program-code SHA-256
> `0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30`.
> Please clarify whether the October 2025 audit covers that exact build. We
> need to independently reproduce and assess the deployed code; no wallet
> credentials are involved.

### RPC or validator operator

> Do you offer an authenticated, synchronized Jito-Solana endpoint where one
> request independently computes fees for each exact message and simulates the
> whole ordered bundle using the same frozen bank object, returning a bank
> identity and request bindings? Can you document the implementation, canonical
> bank and client identity guarantees, response fields, pricing and access?
> Standard `simulateBundle` plus a separately routed `getFeeForMessage`, even
> with equal slot numbers, is insufficient for this evidence. We are requesting
> read-only simulation only; do not create credentials or change settings.

No external ticket was submitted. A provider claim or signed artifact would
still need independent review and exact verification before any policy change.
The user has no suitable dedicated server; the candidate server details and
unverified costs are in `CODEX-JITO-NODE-AND-JUPITER-20261029.md`. No server was
purchased or started. The custom endpoint has not been validated against a
synchronized node and the live full-swap qualification remains unrun.

Five new signature tests plus the 33 prior evidence tests pass; scoped lint
passes. No deploy, funded trade, user-wallet unlock, signing or submission.
