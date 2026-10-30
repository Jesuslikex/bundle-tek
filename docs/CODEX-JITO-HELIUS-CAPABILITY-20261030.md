# Existing Helius endpoint: bounded read-only capability check

30 October 2026. Base source 767af1d. User authorized the existing Helius
endpoint only, no purchases, changed guards, deployment or funded trades.

The existing ignored local SOLANA_MAINNET_RPC_URL has host
mainnet.helius-rpc.com. No setting or credential was changed or published.

## Result

One Node 24.22.1 network attempt, three sequential paced requests:

1. getGenesisHash confirmed Solana mainnet.
2. getLatestBlockhash at confirmed context slot 463422166.
3. simulateBundle explicitly selected that exact slot, retained the original
   blockhash, skipped signature verification on two entirely zero-signature
   native transfer packets, and requested five pre/post images per transaction.

HTTP 200 returned JSON-RPC -32602: bank not found for the provided slot:
463422166. No 429. Stopped immediately; no retry, alternative slot, commitment
fallback, account override, fee request, signature or broadcast. This is a
native capability probe, not a full swap qualification. A method-specific
bank refusal is not proof of successful bundle simulation or persistent
provider incapability. Routing, retention and fork explanations are unproven.

Same-bank identity, complete account coverage and independent fee evidence are
still unavailable. All bank, fee-bank, qualification, signing and execution
authority flags remain false. Equal numerical slots would not by themselves
establish independent same-bank evidence even if a future simulation succeeds.

## Recorder and verification

New standalone script scripts/probe-jito-helius-capability.mjs admits only
Node24, --live-readonly and the existing HTTPS Helius mainnet host. It bounds
requests to six, responses to 1 MiB each, and total runtime to 45 seconds;
reuses the existing exact-integer JSON parser, native message constructor and
configured RPC pacer. It has no signing/send method or production caller.

An initial local startup refusal made no RPC calls: the existing local esbuild
write behavior required explicit outputFiles persistence. Fixed before the
single actual network attempt. No provider errors or keys are printed by the
startup handler. Missing explicit live flag was separately confirmed refused.

Raw receipt retained in ignored work/jito-helius-capability-1793392629740.json.
The companion public JSON contains only summary and request/reply hashes.
All three request/reply hash pairs and both zero-signature packet fields were
independently verified, including exact slot and no blockhash replacement.

119 tests across the existing strict simulation JSON and exact-slot frame
probe suites pass on Node24. Script syntax, scoped lint and formatting pass.
Those tests are supporting parser/probe regressions, not a mocked full test
of the new standalone script or a full repository suite. Application checks,
shared policies, signing gates and the three unrelated recovery-password
draft files are untouched.

Next: another provider's demonstrated exact-bank/full-image/independent-fee
capability is still needed. No purchase or provider contact is authorized here.
