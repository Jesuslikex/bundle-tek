# Independent atomic Pump simulation

14 October 2026. Local source checkpoint. The full Proxima goal remains open.

## Implemented

`simulatePumpInitialBuy` first invokes the existing independently checked create-only simulation, then constructs and simulates the exact inline version 1 create + developer-buy packet with the same original lifetime. It does not issue an approval, sign, submit or enable the launch UI.

The second stage verifies full gross native/quote allowances; exact developer output and curve token custody; unchanged validated mint supply, metadata and authority; quote-token authority/extension stability; precise constant-product principal and protocol/creator fee totals; retained curve fees and observed buyback-recipient credit; native balance conservation and separate fee/rent spending; volume-account ownership and unchanged unrelated rewards; immutable/executable accounts; program deployment metadata before/after; consistent slots; and original blockhash validity/height headroom. Source accounts are re-read and compared after simulation. Quote cap, token target and fees remain exact integer strings.

For stock quotes, the payer quote ATA must contain the full reviewed quote allowance, rather than merely the amount observed in simulation. Token-2022 custody uses the same canonical identity/state/extension checks as the create path. Native WSOL quote mint identity is checked and unused WSOL custody must remain unchanged. No wrapping is inserted into Pump's direct native-SOL buy.

RPC calls are restricted to read/simulate methods, capped at 48, share a 45-second deadline and honor caller cancellation even for an injected provider that ignores the signal. Creation's shorter deadline remains effective. Review expiry cannot extend the earlier creation evidence. Program metadata hashes are retained, but full deployed-binary attestation is not claimed.

The new fee/volume account decoder is bounded and pinned to official Pump IDL commit `639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22`, source SHA256 `7616681ea557975f9f623ac211080f22a93060781eaf4765b0a488d980997207`. Native tier, USDC stable tier and exotic flat-fee selection and exact-output principal/fee rounding follow official `@pump-fun/pump-sdk` 4.1.0, Git commit `b1a02a5ca87b4a7f3715a3cb921e503e1c2b3a66`. The inspected npm tarball SHA256 is `5c0af15764468ac4c6fa6aaada9653d97eff1ea3532b62bc60da451354faacfb`.

## Verification

- Ten focused Node 24 files passed, **78 tests**. Twelve new collector/state cases cover native, SPL quote and Token-2022 quote settlement, gross funding caps, wrong output, quote diversion, mint/payer authority changes, fee/config drift, unexplained lamports, deployment/source rechecks, lifetime/resource errors, malformed mappings, cancellation, tier selection and volume/reward ownership.
- Actual-source TypeScript, scoped typed lint and production build passed. Existing create-only preflight, signing, API and UI regressions remain green. The old collector's body is unchanged; only raw-account helpers were exported for reuse.
- One public mainnet RPC snapshot decoded current Global and FeeConfig with the new pinned decoder. At slot `456717711`, Global buyback basis points were 5000; the fee account was owned by the expected fee program and had one native and one stable tier. Observed flat/native/exotic rates were protocol 95 bps and creator 30 bps. These are point-in-time configuration observations, not promises about future fees.
- Controlled RPC tests are not funded proof. No actual user's wallet, private project or signed packet was sent to an RPC. No successful real mainnet combined simulation is claimed.

## Remaining before approval/signing

The buyback **allocation rounding rule is not attested**. The collector independently calculates the total protocol fee, conserves its observed paid/retained split, enforces the configured recipient and checks zero/full-share endpoints. It deliberately reports `buybackSplitRoundingAttested=false` for the remaining rule. Do not treat this as complete fee-program audit or silently ignore that flag when adding signing.

Owned project/release/payer/folder guards must wrap this collector in an authenticated read-only API; saved percentage sizing must remain server-derived and packet-equivalent after simulation. Durable approval/reservation, strict version 1 signing codecs, separately approved submission/recovery, all requested holder buys and timing settings, deployed-code/authority review and human-approved funded proof remain required. Existing launch service/UI stays create-only. Every new report retains `signingAllowed=false`, `executionAllowed=false`, `completeLaunch=false`.

Nothing was pushed or deployed. No migration, hosted SQL, API/UI behavior, signing, transaction, Google agreement or credential changed in this checkpoint.

Sources: [pinned Pump IDL](https://raw.githubusercontent.com/pump-fun/pump-public-docs/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump.json), [official SDK fee selection](https://github.com/pump-fun/pump-sdk/blob/b1a02a5ca87b4a7f3715a3cb921e503e1c2b3a66/src/fees.ts), [official SDK curve quoting](https://github.com/pump-fun/pump-sdk/blob/b1a02a5ca87b4a7f3715a3cb921e503e1c2b3a66/src/bondingCurve.ts), [v3 retained fees](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/instructions/TRADE_V3.md).
