# Proxima comparison and wallet onboarding reliability

User intent: make Bundle as good as Proxima or better. This checkpoint improves a verified onboarding weakness; it does not establish complete product or financial parity.

## Comparison basis

Retained REA observations in CODEX-REA-WALLET-ONBOARDING-20261018.md show wallet creation, folder choice and selection-dependent activity controls. Selection enables actions; no wallet generation or financial execution was performed on the reference. Relevant retained records: ev_972a8dac06089e5171075077382af377dc8a58f059e317854be80548ec3f9bab and ev_b64810afa9156c14e62aeb6f48289d98425d38bbd838c0ce6a0218b3abb38139.

Initial REA discovery returned provider_unavailable / endpoint_unreachable. The user then confirmed a PC reboot and reopened the dedicated browser. Windows Chrome's existing debugging endpoint responded; the temporary WSL relay was absent. Restarting the existing loopback/stdio relay restored actual REA discovery (ev_bcd9ace9b33bc3d64470fd4288b52af3879986016c2c17c0ffb3139c0817ebc5) and passive account-page inspection (ev_a0fedf82901e76dd915fd7f838f4dc3a1a489bc8a20146978b6dd17cbcf227ff, 04:53:02.920..04:53:04.176 UTC). No browser/profile/config change, page interaction, storage values or script sources were requested. This is fresh connection proof, not refreshed feature parity. Temporary relay handle81779 must be reverified before reuse.

The broader source/evidence ledger remains CODEX-PROXIMA-UI-PARITY-20261018.md. The other chat's isolated chart/layout work is excluded from this checkpoint and from parity claims.

## Implemented independently in Bundle

The user story is encrypted wallet creation, saving only its public address to the owned workspace, then opening warmup for that exact active wallet.

Previously the public-address POST and subsequent refresh could wait indefinitely while the vault dialog blocked closing and backup actions. A successful write followed by a failed refresh also led to a duplicate-only 409 on retry. The new dedicated public-save helper first reads the current owned workspace, sends at most one public-metadata POST, then confirms all requested active addresses on the exact chain with positive revisions in a fresh response. Existing saved addresses return without another POST. A duplicate or ambiguous transport outcome alone never establishes success. Archived addresses require explicit restoration.

Each IO stage has a five-second deadline including response parsing, at most three stages per invocation. Abort and deadline races release the caller even when transport ignores cancellation; late responses cannot update the workspace. Manual retry reads first. No encrypted key is recreated, exported or sent by this helper. Existing vault retry and backup controls become available again when the bounded callback returns.

Continue to warmup now clears archived view, folder and search filters and any previous saved plan, selects the exact created wallet, and opens warmup. No signing or execution code changed.

## Acceptance and remaining priorities

| Area | Current evidence and acceptance boundary |
| --- | --- |
| Wallet onboarding | Recovery and exact wallet handoff have deterministic mounted/component and helper coverage. Real browser check of this new source remains separate from these tests. |
| Mobile clarity | Existing compact warmup and optional details remain. This checkpoint changes recovery and state transitions, not layout. Fresh phone rendering must not be inferred from jsdom. |
| Volume Bundle | Retained reference captures establish configuration controls only. Bundle's unsigned construction, simulation, reservations and settlement recovery are groundwork; signing remains disabled. Production program qualification and funded settlement equivalence are unproven. |
| Stock pairing | Source still returns signingAllowed:false; repeatable provider qualification remains required. |
| Marketplace | A legitimate supplier, encrypted delivery, payment/order recovery and real inventory remain open. Fixture catalog coverage is not delivery readiness. |
| Strategies | Multi-strategy/session ending semantics and project Cleanup redistribution remain separate gaps. Wallet account cleanup is a different operation. |
| Trust | Audited all-in accounting, complete holder/provider coverage and live financial reliability require their own evidence. Controls and passing fixtures do not prove them. |

Next work should close one measured user flow at a time: backup restore without losing the current vault, complete read-only mobile onboarding, then the remaining strategy semantics and program qualification. Do not remove execution gates merely to match a reference control.

## Validation

Five focused files / 35 tests pass: public-save helper (15), mounted wallet workspace (3), existing browser vault, warmup entry and saved-workspace handoff regressions. Cases cover successful public metadata save, previous-save reconciliation, 409/500 ambiguity, absent/partial/wrong-chain/invalid-revision refusal, archive refusal, non-JSON/401 reads, stalled POST and response-body deadlines, manual retry without duplicate POST, cancellation, and archived/search/folder handoff.

Standalone TypeScript, scoped type-aware lint and production webpack build pass (compilation32.0s, build TypeScript13.8s, exit0). The normal guarded HTTPS preview was offline after reboot and restored using its existing trusted-certificate launcher, temporary handle39863. No certificate installation or browser-security bypass occurred.

Actual signed-in Codex browser at375x812 opened My wallets and warmup for the existing one-wallet account. The saved draft loaded; technical details remain collapsed, and the document scroll width360 is below viewport375. Check wallet history completed with0 SOL and explicit unfunded-wallet guidance; no signature was requested. The viewport override was reset afterward. No vault unlock/new wallet/password was needed. New save failure/retry and filtered handoff scenarios are deterministic fixture coverage, not a new live wallet creation test. The user vault remained locked. No credentials were displayed, provider changed, wallet funded, transaction approved/submitted, push or deployment performed.
