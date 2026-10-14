# Strict Solana signature verification

14 October 2026. Local security fix; not deployed.

During review, a controlled probe showed the previous NaCl verifier accepting an identity public key and identity commitment with zero scalar for an arbitrary message. A second regression reproduces its acceptance of a noncanonical high-S variant of a valid signature. These probes use public mathematical test values and freshly generated disposable keys, not an actual user's account. No compromise of a real account is claimed.

`lib/solana-signature.ts` requires canonical, nonzero prime-order public and commitment points and strict RFC-style Ed25519 verification through an explicitly pinned `@noble/curves` 1.9.7 dependency. Small-order and mixed-torsion points, noncanonical encodings, malformed lengths and out-of-range signature scalars are rejected. Ordinary wallet signatures retain their existing flow. This verifies signatures only and never reads a private key, creates permission, signs or broadcasts.

Wallet-login challenge/verification schemas also reject unusable public keys before issuing a nonce. All production NaCl verification call sites now use the strict helper: devnet/workspace ownership proofs, wallet login, exact swap verification, native withdrawals, Pump signed packets, recoverable/external wallet outputs, warmup signing and approval-history recovery. NaCl generation/signing functions remain unchanged. EVM verification remains unchanged. Watch-only addresses are not globally prohibited; only cryptographic signing identities are restricted.

Verification: thirteen focused Node 24 files passed, **91 tests**, covering real libSQL login/session behavior, wallet ownership, nonce/signing routes, withdrawal and warmup recovery. The initial RFC vector test contained one extra hex digit; that fixture was corrected. After switching deprecated point aliases to the supported `Point.fromBytes`/`toBytes` APIs, five core files were rerun with **21 passing tests**. Actual-source TypeScript, scoped typed lint and the production build pass. Direct adversarial regressions reproduce the old acceptance and prove the new rejection; a public RFC 8032 vector and ordinary signatures still verify.

The dependency layout retains Viem/Ox's exact older versions under their own paths and deduplicates Token-2022's existing 1.9.7 dependency. No unrelated package upgrade, credential change, hosted SQL, UI edit or transaction is included. Wallet login remains undeployed and real-extension login proof is still outstanding. This fix does not complete atomic initial-buy signing or full Proxima parity.

Sources: [RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032), [Noble verification policy](https://github.com/paulmillr/noble-curves#ed25519-signatures), installed pinned library types/source and the committed executable regression tests.
