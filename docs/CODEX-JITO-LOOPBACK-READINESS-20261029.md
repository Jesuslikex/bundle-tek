# Jito synchronized-validator readiness and loopback transport, 29 October 2026

## Local machine readiness

Ubuntu WSL2 exposes 16 logical CPUs and approximately 15 GiB of RAM. The C:
volume had approximately 93 GiB free at this check. The local patched Jito
validator binary exists and reports `agave-validator 4.5.0-alpha.2`, source
`256fbf9b`, client JitoLabs. It was not started as a mainnet node.

Anza's current [requirements](https://docs.anza.xyz/operations/requirements)
are operational guidance, not a formal mathematical minimum: they recommend
256 GB RAM, 1 TB each for accounts and ledger, 500 GB for snapshots, and a
public IP/network connectivity for a validator. This PC is far below the memory
and storage guidance and is in WSL. Attempting an enormous sync here would not
establish a dependable, timely mainnet bank. A suitable synchronized node and
its operator-controlled, authenticated access remain prerequisites. No cloud
resources were purchased or provisioned, and no public RPC port was opened.

## Bounded local transport

`lib/jito-same-bank-loopback.ts` is an unmounted research collector. It accepts
only a literal numeric IPv4 loopback HTTP endpoint with an explicit port and
root path, builds and sends one exact simulation request, rejects redirects,
non-success HTTP, invalid context and spans over 32 slots, and passes the raw
response and exact sent body to the existing research adapter. It does not
retry and is bounded by timeout and existing response size limits. It has no
API, production configuration or execution wiring. Tests use a synthetic local
HTTP server, not a synchronized validator.

The actual request is bound to the collector in this local test, but loopback
alone does not identify the server process or authenticate its bank. A malicious
local listener could fabricate a consistent response. Therefore the result
retains `bankIdentityVerified`, `sourceAuthenticated`, `providerQualified`,
`signingAllowed` and `executionAllowed` as false. The collector is not trusted
transport for the production qualification, and does not lift existing gates.
Process identity, isolated transport, synchronized canonical-bank health,
source-code pinning, runtime integration and independent assessment remain.

## Fresh Jupiter observation

One confirmed read-only `getMultipleAccounts` call to Solana's public mainnet
RPC requested the Jupiter v6 program and its previously recorded program-data
account together. The response context slot was `462746049`. The response had
both accounts owned by the upgradeable loader; the executable Program account's
link matched the requested program-data address, and the ProgramData header
reported deployment slot `459479624`. The returned program-data account was
2,892,269 bytes; excluding its 45-byte loader header gave 2,892,224 bytes with
SHA-256 `0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30`.

This is a single provider observation, not independent source provenance or a
reproduced build. It agrees with the retained historical binary but differs from
Bundle's current `099da3a26d336aa7174960f057546f192fc1ccda8e3e9d1b4aa5c69fa8a79a5f`
pin. The [verification service](https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)
returned `is_verified: false`, with no executable hash, source repository or
commit. No pin was changed. This observation does not prove the program unsafe;
it does not satisfy the existing reviewed code-identity policy.

## Tests and remaining work

Four focused Bundle files passed 178 tests, including local transport refusal
of redirects, rate limits, malformed JSON, pre-cancellation, non-loopback URLs,
packet or fee changes and 32-slot violations. Whole-project TypeScript and
scoped lint passed. These tests are synthetic. The synchronized validator,
trusted process/transport identity, verifiable Jupiter source-to-binary link,
full runtime integration and live full-swap read-only qualification are not
complete. No checks were loosened and no deployment, credentials change,
funded action, signing or submission occurred.
