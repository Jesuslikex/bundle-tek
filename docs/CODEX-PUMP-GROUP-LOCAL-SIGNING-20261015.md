# Browser-local complete Pump group signing

15 October 2026, based on 3750257. Adds the local signing primitive for every packet in an immutable complete launch group. This checkpoint does not expose group signing through the production API/UI or authorize any real signature.

## Behavior

signPumpLaunchGroup accepts the complete immutable review, its exact group/manifest/context/simulation consent, the exact map of unlocked Solana vault identities, a required synchronous live UI/vault guard and optional AbortSignal. The caller must obtain durable approval and establish runtime/provider/program qualification before unlocking. Consent and review reconstruction alone cannot establish those external facts.

The primitive reconstructs and validates all original unsigned packets and the saved plan before accessing private seeds. It rejects missing/extra sessions, including inactive zero-buy holders. Every selected seed must uniquely match its reviewed address, including wallets only present in the final packet, before the first signature is created.

Packets keep their original order, messages, lifetime, instruction layout and signer sets. The mint signs the creation packet; the deployer signs every packet where required and active holder signatures are added only to the packets that require them. No tip, recipient, fresh blockhash or alternate packet is inserted.

The caller guard, cancellation and expiry are checked at asynchronous boundaries, between wallets/packets and before returning. Once identities are prepared, changed session-map selections or selected seed contents also reject. Failure returns no partial group. A strict independent complete-group verifier checks every resulting signature and creates the canonical ordered signed-evidence digest for the existing immutable registration service. Its ownership, approval, lifetime and runtime qualification requirements remain explicit; signingAllowed, executionAllowed and completeLaunch stay false.

Temporary seed byte arrays and derived secret-key byte arrays are overwritten in finally blocks on success or error. The caller's unlocked VaultSession is not modified or locked by this primitive. Its existing seed strings and session lifetime must be cleared by the future UI's vault/session lifecycle; JavaScript strings cannot be reliably erased. No private seed is returned, persisted or transmitted.

## Verification

Four selected test files passed all 42 tests, including 13 new signer cases and the independent group signature/review and existing holder signer regressions. The retained report is work/group-local-signing-tests.json. Controlled tests generate synthetic keys only and make them extractable solely in the test module. They do not decrypt or inspect a user vault.

Cases cover multi-packet SOL and SPL/Token-2022 stock quote groups, unchanged ordered messages, creation-only mint coverage, zero-slot exclusion, all exact consent fields, bad final-packet identity before any signature, missing/extra/malformed/duplicate/EVM identities, corrupted review bindings, required synchronous guard, partial cancellation, vault mutation, expired signing versus historical verification, and temporary private-byte cleanup without modifying caller sessions. Network calls during the local signer are prohibited by the test.

Current-source TypeScript and three-file typed lint completed successfully before the production build started. The production Next.js webpack build also passed; its ignored log is work/group-local-signing-build.log. No new migration is needed. The shared review fixture now supports explicit stock/token-program variants; its default reconstruction/signature regressions passed in this run.

## Remaining integration

The next integration must preserve explicit whole-group approval, fresh ownership/source checks and a live UI/vault context across unlock/sign/register. It must add qualified complete/partial/unknown recovery and an explicitly reviewed one-attempt transport/tip policy before enabling execution. More than five packets has no enabled policy; no truncation or sequential fallback is introduced. Runtime code/authority and live v1 replay/transport qualification remain open.

No UI/protected Claude files, migration, remote SQL, provider configuration, credentials, cron, push, deployment, user-wallet signature or transaction submission changed. The live production release remains b58355d. Main's unrelated Jito note and 0068 SQL edits are preserved. Full Proxima parity remains unfinished.
