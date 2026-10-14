# Complete launch-group review contract

14 October 2026, based on 12c66de. Adds immutable complete-group review and consent validation. This is the contract needed before durable persistence and approval; it does not save a review, reserve wallets or grant signing authority.

## Implemented

The single-packet holder review's saved-plan validation is extracted into a shared helper. Both review formats validate the exact saved document's deployer and holder slot order, quote identity/precision, supply-derived developer and holder targets, distribution and denomination, active/zero participation, canonical fee/rent allowances and per-wallet quote/output limits. The single-packet report shape and unsigned transaction validation remain unchanged. The allowance digest uses the existing ordered representation and browser-compatible WebCrypto.

The new group review format contains all canonical ordered unsigned packets, packet hashes, exact signer sets and covered holder indices, complete encoded creation/developer/holder input, saved project document and revision identity, ownership-binding digests, allowance digest, collected simulation and its digest. A canonical whole-context digest binds those fields together.

Validation independently rebuilds the full group from encoded inputs and the saved targets. Every packet byte/hash/index/signer/holder assignment must match the rebuilt group. Missing, reordered, duplicated, signed or substituted packets reject; groups outside the current one-to-five review profile reject. Zero allocation slots remain present in the input/document/manifest even when they do not sign a packet.

The simulation binding must cover the same manifest and allowances, one replay, every economic prefix and frame packet hash, complete packet count, compatible bank range and bounded observed expiry. Required code/transport/authority review disclosures and disabled signing/execution flags cannot be changed. Expiry cannot be extended beyond collected evidence. Expired records remain inspectable through explicit historical validation without becoming usable for signing.

Exact consent names the review, complete manifest, context and simulation digests, the whole-group create/developer/holder scope and acknowledgement of simulation limits. Consent schema rejects missing/mismatched fields and extra fields. This function validates supplied consent only; it neither obtains user consent nor records durable approval.

Both review outputs explicitly retain ownershipVerificationRequired=true, simulationSourceVerificationRequired=true, signingAllowed=false and executionAllowed=false. Binding a caller-supplied report hash is not independent proof of its RPC origin. The eventual owned server preparation service must collect trusted evidence and revalidate ownership/revisions; it must never accept an arbitrary client-authored simulation as that proof.

## Verification

- Nine selected group review/simulation/accounting/trace/funding, holder review/signing, holder panel and holder-route files passed 105 tests. The first focused three-file run passed 40 tests.
- Group tests use the real read-only collector with independently constructed controlled account/economic fixtures and an all-base saved distribution. They are not BPF, live RPC or actual wallet signing proof.
- Missing/reordered/duplicate packets, changed signer coverage and slot ordering, altered saved targets/allowances, skipped simulation prefixes, substituted frame hashes, asserted signing permission, expired/extended expiry and incomplete/mismatched whole-group consent reject.
- Existing single-packet review persistence/ownership/concurrency, signature and API/UI regressions pass.
- The controlled simulation fixture was moved to test/pump-launch-group-simulation-fixture.ts; existing simulation test assertions remain intact. An all-base mode was added for review-plan parity.
- Actual-source TypeScript, six-file typed lint, whitespace checks and production Next.js build passed. Ignored build log: work/group-review-build.log.

## Required continuation

Add owned group preparation, immutable durable reviews, atomic project/wallet reservations and revision transitions, explicit approval, all-packet signature registration, qualified one-attempt submission and complete/partial/unknown recovery/UI. Existing migrations only guard single-packet holder reviews, so the group format must not be inserted into that service or table without new tested guards. Live unsigned v1 replay, transport/tip and code/authority qualification remain open. More than five packets still has no enabled execution policy.

No migration/remote SQL, UI/protected Claude file, actual provider read, credential/provider change, cron, push, deployment or real-wallet action occurred. Migration 0081 remains local; main's unrelated dirty files are preserved. Full Proxima parity remains unfinished.
