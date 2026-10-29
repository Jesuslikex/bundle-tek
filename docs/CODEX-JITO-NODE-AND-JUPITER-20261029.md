# Jito validator options and Jupiter cross-provider observation

29 October 2026. This is read-only research, not a production change or a
passing qualification. The diagnostic capture is
`CODEX-JUPITER-TWO-PROVIDER-20261029.json`; it retains computed results, not
the full raw RPC responses. `scripts/jito-jupiter-public-hash.mjs` makes only
`getGenesisHash` and `getMultipleAccounts` requests to two fixed public
endpoints, uses bounded responses, checks the known mainnet genesis, loader
ownership, executable flags, canonical encoded account data, ProgramData link
and loader headers, and hashes code after the 45-byte ProgramData header. It
has no credential input, signing or submission. The script is diagnostic: it
does not authenticate a provider, verify canonical fork identity or establish
source provenance. Eleven synthetic parser and refusal tests pass.

At 04:40 UTC both Solana public RPC and PublicNode returned the same SHA-256
`0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30`, code
length 2,892,224 bytes, deployment slot 459479624 and authority
`CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ`. Context slots differed by
one; this is not an assertion that the two responses came from the same bank.
Their agreement corroborates byte observation, not a reproducible-source match.
Bundle still pins `099da3a26d336aa7174960f057546f192fc1ccda8e3e9d1b4aa5c69fa8a79a5f`.
The [public verifier](https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)
again returned unverified without a repository, commit or executable hash. The
[Jupiter audit index](https://developers.jup.ag/docs/resources/audits) lists v6
reports, but none of the information inspected ties the current binary to the
audited source revision. A verified source/build and assessment are still needed;
[Solana's verified-build guide](https://solana.com/docs/programs/verified-builds)
describes the repository-and-reproducible-build route. Audit, provider agreement
and program ID are not substitutes. No pin or signing guard was changed.

## Candidate infrastructure, not yet a synchronized validator

The [DediPeak D48](https://dedipeak.com/solana-dedicated-servers) is a
plausible bare-metal candidate advertised at $329/month before applicable tax,
with 48 cores, 256 GB RAM, two 3.84 TB NVMe drives and 10 Gbps. The vendor says
it provides root access and the customer installs the validator. This is a
vendor claim and price snapshot, not an endorsement, provisioned resource,
proof of network sync, proof of trusted execution, or confirmation that all
Anza recommendations (including snapshot placement) are met. Availability,
terms, actual traffic, disk separation, synchronization, secure operator access,
custom binary deployment, and any additional charges need verification.
[Anza's guidance](https://docs.anza.xyz/operations/requirements) is the
reference for sizing and warns about operational requirements. A node would
need to run the separately reviewed patched binary, synchronize to mainnet,
prove health and bank context, and use authenticated restricted access; the
current loopback prototype and matching slots alone do not establish these.
Buying a server would not itself resolve Jupiter provenance.

[QuickNode's documentation](https://www.quicknode.com/docs/solana/simulateBundle)
describes the standard `simulateBundle` method with its Lil' JIT add-on; it
does not document the custom single-bank independent-fee method used by this
prototype. Do not infer that the standard API supports that method or proves
the same bank. No provider was configured or purchased and no server was
started. The full live read-only Jito qualification remains unrun; existing
32-slot, code, fee, custody and signing checks remain intact. No deploy or
funded action occurred.
