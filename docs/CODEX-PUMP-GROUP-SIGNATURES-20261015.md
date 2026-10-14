# Complete-group signed packet verification

15 October 2026, based on 96613e9. Adds pure cryptographic verification of every signed packet in an immutable launch group. It does not access wallet keys, create signatures, register them or send transactions.

The verifier reconstructs the entire historical review and unsigned group. It requires one through five canonical bounded encodings and exactly the reviewed packet count/order. Each decoded message must equal the corresponding original message byte-for-byte, including its version, original blockhash, instructions and account roles. Decoded signer identities must match the exact expected signer set, and every deployer, mint and active holder signature must pass the existing strict Solana signature verifier.

Evidence retains all signed packets, ordered unsigned/signed packet hashes and payer transaction signatures. A canonical signed-group digest binds those values to the review ID, complete manifest and immutable context. No subset or independently altered packet can represent the group.

Expired saved reviews can still be verified for registration/recovery evidence. This does not establish live lifetime, owned revisions, durable consent, runtime qualification or submission permission. The result explicitly keeps those checks required and signingAllowed=false, executionAllowed=false and completeLaunch=false.

## Verification

- Final four selected group signature/review, existing holder signing and durable group service files passed 45 tests with two workers. Initial three-file run passed 28 tests before adding the final missing-holder case.
- Nine group signature cases cover every complete signature, deterministic evidence, missing/reordered/duplicate packets, valid signatures over a changed message, missing first-packet mint signature, missing final-packet holder signature, copied payer signature, noncanonical/trailing bytes, expired-review inspection and cancellation.
- Signatures are created only inside test code with generated synthetic test keys. No actual wallet or network is used. The verifier's fetch spy confirms no request. These tests do not qualify real RPC/BPF/funded execution.
- The controlled review fixture was moved to test/pump-launch-group-review-fixture.ts so signature and existing review tests use the same collected model; review assertions remain unchanged.
- Final-source TypeScript, four-file typed lint, whitespace checks and production Next.js build passed. Ignored build log: work/group-signature-verification-build.log.

Next connect qualified browser-local full-group signing and immutable registration, then submission and recovery/UI. Runtime/transport/tip/code qualification remains open; approval alone does not authorize signatures. No API/UI/protected Claude file, migration/remote SQL, actual provider read, credential change, cron, push, deployment or real-wallet action occurred. Migrations 0081/0082/0083 remain local. Main's two unrelated dirty files are preserved. Full Proxima parity remains unfinished.
