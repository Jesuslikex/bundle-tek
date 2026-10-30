# Raydium CPMM candidate checks, 30 October 2026

These checks are isolated research code and are not connected to the Jito qualification, UI, signing or sending paths. They retain `sourceAuthenticated`, `programApproved`, `packetVerified`, `economicOutputVerified`, `providerQualified`, `signingAllowed`, and `executionAllowed` as false. No policy, slot, bank, signing or execution guard was changed.

## Implemented

`lib/jito-cpmm-candidate-instruction.ts` checks a supplied instruction candidate against Raydium's published `swap_base_input` form: exact discriminator and 24-byte layout, thirteen ordered accounts, signer and writable constraints, distinct roles, the program-derived pool authority, canonical SPL Token ATAs for the payer and the two mints, and exact positive u64 input and user-supplied minimum output. It refuses Token-2022, temporary non-ATA accounts and unrecognized variants. These are conservative restrictions, not support for every valid CPMM swap. The caller-supplied instruction, metadata and expected amounts are not authenticated or bound to a real packet.

`lib/jito-cpmm-candidate-balances.ts` uses that inspection and compares supplied SPL Token account pre/post images for the source, destination and both vaults. It checks token program ownership, initialized account state, mint and authority, disallows delegates and close authorities, keeps all other token-account bytes unchanged, checks exact input and vault conservation and minimum output, and checks wrapped SOL reserve/lamports consistency. Raw account inputs are bounded and snapshotted before async work. This is not proof the images came from a real simulation, or from the same bank, nor a quote, whole-packet, full economic or provider verification.

## Live program recheck

The existing strict Jito runtime scan against the configured Alchemy holder endpoint, without a wallet or transaction, observed the same 793,824-byte CPMM program and full-code SHA-256 `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a` as the previous observation. Floor 463345597, maximum slot 463345605, nine HTTP reads, no 429. It correctly refused the unlisted program; no policy was added. This is not a before/simulation/after scan and does not qualify a route.

The OtterSec status endpoint again reported `is_verified: false`, `last_verified_at: null`, and no matching executable hash for CPMM. The referenced public source commit has not been proven to produce the deployed binary. This machine has no accessible Docker, Solana CLI or solana-verify command, so no independent deterministic build comparison was completed. Other verification sources may exist, but none was established here. Even a matching reproducible build is not a security audit.

## Remaining before qualification

- Independently verify the deployed program's source and build, then separately review and pin its identity under existing policy.
- Bind instruction review to the exact transaction bytes, account privileges, selected route and approved quote. Verify the actual pool, config, mint, vault and oracle data and freshness, all instructions and all economic/rent/fee effects. Only then can a complete adapter use these isolated checks.
- Obtain synchronized, authenticated same-bank simulation and independent fee evidence. Perform both existing full program scans and the actual full-swap bundle simulation within the original 32-slot window. No run in this change did that.
- Keep signing and execution disabled until the full existing qualification succeeds. No deployed or funded actions were taken.

Sources: https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/swap_base_input.rs ; https://solana.com/docs/programs/verified-builds ; https://verify.osec.io/status/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C

## Follow-up audit, 30 October 2026

The candidate inspectors remain imported only by each other and their tests, not by an application API, UI or Jito admission path. Their false authority flags are intentional. A caller can supply internally consistent synthetic instruction/account data, so passing these inspectors alone cannot establish a safe real swap.

Fixed a candidate shape gap: the CPMM executable address is now forbidden in every one of the thirteen data-account roles. Added thirteen regression cases plus exact minimum-output boundary cases (110 accepted, 111 refused against an actual output of 110). This tightens checks without changing any production policy.

Current completion map:

| Layer                                                                        | State                                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Candidate instruction structure, canonical ATAs and amount binding           | Implemented and unit tested; caller inputs unauthenticated |
| Four supplied SPL account balance transitions                                | Implemented and unit tested; provenance unauthenticated    |
| Exact transaction decoding, complete instruction coverage and lookup binding | Missing for this direct-route adapter                      |
| Pool/config/vault/oracle ownership, mint/rent and independent price evidence | Missing for this direct-route adapter                      |
| Deployed Raydium binary matched to a reproducible reviewed source build      | Not established                                            |
| Raydium trusted program policy approval                                      | Absent; existing refusal preserved                         |
| Authenticated same-bank simulation and independent fees                      | Not established                                            |
| Full swap with both runtime scans inside 32 slots                            | Not qualified                                              |

No production/live-site audit, complete product parity, deployment or funded verification is claimed by this source audit. Preserve the three unrelated untracked recovery-password files.

## Exact unsigned packet binding

Added `lib/jito-cpmm-unsigned-packet.ts`: canonical transaction and message decode/re-encode, 1232-byte cap, exactly one unsigned payer, exact fee payer, unique static keys, no unresolved lookup tables, no unused keys, and a single read-only-program CPMM instruction. Account signer/writable roles and data are derived from message bytes, then passed to the existing candidate inspector. Original transaction/message hashes accompany the diagnostic. Signatures, extra instructions, lookup-based routes, setup/wrapping instructions and malformed envelopes are refused. This is a narrow existing-ATA profile, not full real-world route support.

Validation: two candidate test files pass 59 tests including an independently constructed raw-wire packet and signed/header/trailing-byte/amount mutations. Typecheck and scoped lint pass.

`instructionBoundToPacket` is true only after byte binding. `packetVerified`, `accountStateVerified`, `priceVerified`, `economicOutputVerified`, program/source/provider approval and signing/execution remain false. Blockhash lifetime, pool/config/oracle and raw mint/rent/independent price evidence are still missing, as are actual same-bank provenance and the full runtime qualification. No call site enables this module for signing. No new live provider or funded run was made in this step.

## Packet-bound mint and Rent read collector

`lib/jito-cpmm-asset-evidence.ts` derives the two mint addresses from the unsigned packet inspector and reads them with the fixed Rent sysvar through an injected read-only RPC. It uses the existing mint and Rent parsers, allows only the classic SPL Token profile, repeats observations at a monotonic floor, and refuses a changed mint transfer policy or Rent profile. Both observations must fall inside the original 32-slot window. Reads have cancellation, a 30-second collector deadline and bounded JSON snapshots; no retries or fallback provider. The returned rent minimum is for a 165-byte token account, not proof that any actual account is rent-exempt or that creation funding is sufficient.

The collector is unmounted research code, not a runtime admission proof. RPC provenance is supplied by the caller and not independently authenticated. The two reads do not surround an actual swap simulation, and no same-bank claim is made. Pool/config/oracle verification, independent market-price evidence, full mint/account/rent conservation, source-to-binary approval and actual same-bank qualification remain incomplete. The existing false authority fields remain false.

Validation: 65 tests across the three CPMM test files, typecheck and scoped lint passed. After adding the explicit timeout, all six new collector tests passed again. New tests mock the packet inspector and RPC to isolate collector behavior; separate packet tests test real synthetic transaction bytes. No live provider run, deployment or funded action occurred in this step.

## Pool relationship and actual rent coverage observations

The new unmounted `readJitoCpmmPoolEvidence` binds to the same unsigned packet, reuses mint/Rent evidence, then reads the pool and four token accounts with a floor at or above the asset observations and within the original 32-slot window. The conservative 637-byte historical PoolState profile checks owner, discriminator, config/observation addresses, vault/mint direction, mint decimals, token programs, authority bump and swap-disabled bit. Unknown layouts refuse. The actual pool and token-account lamports must cover their decoded-size rent minima. Classic token accounts must match expected mint and wallet/vault authority and have no delegate/close authority; wrapped SOL must carry the exact observed Rent reserve with matching lamports and token amount.

This does not validate config/oracle account contents, pool open-time against Clock, mint account rent, independent prices or simulated post-state rent. It is not proof the referenced source equals the current deployed binary. `poolVerified`, `priceVerified`, same-bank/provider and signing/execution remain false. No application path imports this collector.

Validation: 81 tests across four CPMM files, typecheck and scoped lint pass. Pool tests use mocked packet and asset collectors and synthetic raw accounts; they cover account rent shortfalls, changed pool relationships, disabled swaps and the original slot bound. No live provider run, deployment, signing or funded trade occurred in this step.

## Independent market-value comparison

`readJitoCpmmPriceComparison` reuses the existing server `observeTokenMarket` adapter and packet/mint collectors. It requires explicit external input/output market-pair addresses and refuses either reference if it equals the packet's execution pool. It checks exact Solana mint/source identity, a unique selected pair, positive supported decimal prices and observations no older than five minutes or future-dated. No stablecoin peg is assumed. Integer cross-products normalize the packet input and encoded minimum output using observed mint decimals. A worse minimum exceeding 2 percent requires acknowledgement; missing observations also explicitly require acknowledgement. This diagnostic does not grant that acknowledgement or permission to sign.

This compares the encoded minimum's market value, not an expected executable quote or guaranteed fill. Dexscreener retrieval time does not attest the timestamp of an underlying trade. Market provenance, saved owner approval/revision, selected reference authorization and a fresh executable quote still need the actual server/UI integration. The module is unmounted and `priceVerified`, provider/signing/execution flags remain false. It uses bounded snapshots, a 30-second collector deadline and cancellation, with no retries. It does not alter existing minimum-output rules.

Validation: 93 tests across all five CPMM files pass, plus typecheck and scoped lint. New cases cover the exact 2 percent boundary, better prices, mixed mint decimals, execution-pool exclusion, stale/future/unrelated/source/duplicate/missing observations and redacted provider failures. Tests inject synthetic observations and packet/asset inspectors. No live price, funded trade or full Jito qualification is claimed; no deploy was made.

## Config and oracle structural observations

The pool collector now requests the packet-bound config and observation accounts in the same account response as the pool/vaults. The referenced historical source profile requires a 236-byte AmmConfig and a 4075-byte ObservationState, the correct Anchor discriminators and CPMM owner, and actual rent coverage. Config checks bound trade/protocol/fund fees to the published millionths denominator and reject a protocol-plus-fund share above the denominator. The oracle bool and ring index are bounded and its stored pool ID must match the packet pool. Oracle cumulative prices are not used as an independent price reference. Unknown layouts refuse.

Source references: https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/states/config.rs and https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/states/oracle.rs . Exact source-to-deployed-binary matching, config/oracle PDA derivation, pool open-time/Clock and full runtime admission remain open. No signing, provider or bank authority flag was enabled.

Focused pool tests cover seven new corruption/fee/ring-index cases (23 pool tests total). Typecheck and scoped lint pass. These are synthetic fixtures, with no live RPC, funded transaction or deployment in this step.

## Canonical PDAs and pool opening time

The config index is decoded little-endian from account bytes and encoded big-endian for the published `amm_config` PDA seeds; address and stored bump must both match. The observation PDA uses `observation` plus pool bytes, and vault PDAs use `pool_vault` plus pool and exact mint bytes. PoolState itself is not forced to a PDA: the referenced Raydium initialization explicitly permits a random signed pool account.

The same eight-account pool response now includes the fixed Clock sysvar. Existing `pairClockUnixTimestamp` enforces exact Clock/context slot equality and its unchanged 30-second wall-time bound. Pool open_time must be no later than this Clock, and an initialized oracle's latest ring entry cannot be future-dated against it. This uses ordinary equality, never the stock-only +1 rule. These observations are still not proof that simulation and independent fee reads share a bank, nor a verified source/binary policy.

Sources: https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/admin/create_config.rs and https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/initialize.rs .

Validation: 106 tests/five CPMM files, typecheck and scoped lint pass. Fixtures derive actual Solana PDAs and test config index/bump mutations, an internally linked wrong oracle PDA, Clock behind/+1 refusals and a future pool open time. Tests remain synthetic and isolated; no live provider, deploy, signing or funded run occurred. Remaining full qualification includes mint rent, full economic/fee/rent settlement and lifetime integration, authenticated source/build and same-bank provider evidence.

## Actual mint rent coverage

Both asset observations now require positive rent coverage for each decoded classic SPL mint: exact 82-byte account data, canonical u64 lamports, and lamports at least the rent minimum calculated from that observation's Rent sysvar. Per-mint actual and required lamports are retained in each observation. A mint rent shortfall on the final read is refused even if the initial read passed. This does not establish simulation post-state rent or a payer's whole-transaction fee budget.

Validation: 111 tests across six focused CPMM/qualification files, typecheck and scoped lint pass. Added synthetic underfunded-input/output and final-read-shortfall regressions. Existing tests now supply actual mint lamports rather than leaving them absent. Program/source approval, same-bank provider proof, full economic/lifetime integration and live repeatability remain open; no qualification or signing flag changed. No live provider call, deploy or funded action occurred here.

## Reproducible-build attempt started

A local Ubuntu WSL Docker runtime was installed (docker.io 29.1.3, no TCP daemon listener configured) and the exact public source was checked out separately at `/root/raydium-cpmm-verification`, detached commit `cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce`. Cargo.lock SHA-256 is `072dbd239b1dbeda0bcb6eb3f47314a59af19cb62a33f80a6b830e6a7cc9c520`; Anchor.toml SHA-256 is `ccc70025be87773e9ba74948cf30571bed6031d4ca081ac467d8fbef7c2cb5f9`.

Anchor.toml names Solana 1.17.0, but the lockfile resolves solana-program 1.16.25. The inspected verifier source at commit `26ba8211eddbfab49d30826d15a2408332b89543` chooses a lockfile version in the absence of workspace CLI metadata. The first attempt therefore uses `solanafoundation/solana-verifiable-build@sha256:43206149a565ec35da95b1a909f4714f5d5f0d8241c31df24189e517acd18467`, successfully downloaded by digest.

The named local container `bundle-raydium-verify-11625` is running, with 4 CPU/6 GiB limits and only that public source mounted at `/build`. It runs `cargo fetch --locked --manifest-path programs/cp-swap/Cargo.toml` followed by `cargo build-sbf -- --frozen --locked --manifest-path programs/cp-swap/Cargo.toml`. At the checkpoint it is fetching the crates.io index. Resume by inspecting this container and its logs, not by starting a duplicate build. Tool session 39058 also owns its attached output. No binary result or comparison exists yet.

The verifier normalizes executable bytes by trimming trailing zero padding before SHA-256. This must be distinguished from Bundle's full-code pin; normalized equality alone must not silently replace the reviewed full-code policy. A successful compilation would still require an actual deployed-byte comparison and separate review. No wallet/provider secrets are mounted; no deployment, hosted SQL, signing or funded action occurred.

## Composition coverage and direct reserve quote

Added a composition test that constructs unsigned packet bytes independently, derives real Solana PDAs/ATAs, and supplies raw mint/Rent/Clock/pool/config/oracle and wrapped-SOL/token account fixtures through the actual collectors. Only RPC and the external market-data boundary are injected; the packet/asset/pool/price modules are not mocked. It verifies shared transaction hashes, observed coverage and exact minimum-output units, and refuses changed review terms, insufficient wrapped-SOL backing and insufficient source tokens.

The published CPMM math is now applied to observed vault reserves. Accrued protocol/fund fees are excluded from tradable reserves. Trade fees use ceiling division; protocol/fund shares use floor division. Exact integer constant-product output must meet the packet's encoded minimum. Zero output, empty or overdrawn reserves, impossible fee rates, vault/counter overflow and insufficient source balances are refused. The public source being modeled is still not proven to equal the deployed binary, so no policy/signing authority follows from this calculation.

This exposed an unrealistic earlier synthetic composition fixture: its minimum exceeded the output supported by its reserves. The fixture now has coherent reserves, a 1 percent encoded minimum below the independent USD value and an executable expected output of 99749 raw units. A separate regression keeps the higher minimum and confirms refusal, rather than relaxing the output rule.

Validation: 251 tests in 11 CPMM/Jito files, plain typecheck and scoped lint passed. Pure math tests cover exact-minimum/one-unit-beyond, fee rounding, overflow/fee refusals and a deterministic reserve/amount/rate grid. These tests do not establish live same-bank provenance or full bundle qualification. Source build remains pending.

Formula sources at the referenced source revision: programs/cp-swap/src/curve/constant_product.rs, curve/calculator.rs, curve/fees.rs and instructions/swap_base_input.rs under https://github.com/raydium-io/raydium-cp-swap/tree/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce .

## Independent on-chain artifact capture and historical build result

Added `scripts/capture-raydium-build-reference.ts`, an explicit `--live-readonly` diagnostic. It checks the mainnet genesis, the program-to-ProgramData link, loader/deployment headers, declared account size, bounded serial code slices, monotonic slot floors and unchanged deployment metadata. It stores the public executable and sanitized receipt only in ignored `work/`. It is hard-bounded to the observed 793824-byte candidate, never approves a new program and does not sign or simulate a transaction. No provider URL is printed.

The actual capture used floor 463357276 through 463357282, five runtime HTTP reads with no 429. Full code SHA-256: `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a`. Trimming trailing zero padding leaves 722617 bytes with normalized SHA-256 `93cad2458ac72435c94b8ac89faa686987f4e29d2f0e862d546fbc5aa814a0d2`. Artifact: ignored `work/raydium-cpmm-onchain-463357276.so` and its `.json` receipt. The final-size recheck was added after this capture; the command typechecks and lints. The artifact is observed reference data, not a source verification.

The first container `bundle-raydium-verify-11625` exited1 after registry fetch because the relative manifest argument was resolved from a different build directory. After preserving the registry cache under `/root/raydium-cpmm-registry-cache`, `bundle-raydium-verify-11625-absolute` used the same pinned image with `cargo build-sbf --manifest-path /build/programs/cp-swap/Cargo.toml -- --frozen --locked` and exited0. Cargo.lock remains unchanged. The built file is `/root/raydium-cpmm-verification/target/deploy/raydium_cp_swap.so`, 535664 bytes, full hash `4ec452fc44ad608c638a08355b8f964c92109a646f63ab481f98ee5e90c00e7b`, normalized length535649/hash `52bc8ca009c37a363c7314344fb2c7c43314fecdd207d67846b0f22e746f9fae`. Both normalized comparison and padded full-byte comparison against the captured on-chain program are **false**. This source/toolchain candidate cannot clear binary verification.

Public strings in the captured executable include creator-fee/share and permissioned-initialize identifiers absent from that historical source. Current official public source reuses old account padding for creator-fee state without changing account lengths. The historical pool/config/oracle profile now explicitly rejects nonzero reserved bytes (including those newer fee fields); regression tests cover these cases. This preserves conservative historical support and does not claim that the newer deployed fee model is supported or verified.

A second candidate checkout exists at `/root/raydium-cpmm-current-verification`, detached `f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5` (current public master at observation). Its Cargo.lock hash is `9fd6ae76c394140ed7f2840b29ee4af0fbd857bc8bd7099fc6c35adbd6b1e183`; Anchor.toml hash `90291619f263e630a3b11420665a3370e6fd7505c869ff9ef561f1341ab89421`. It selects Solana3.1.10 in workspace metadata and includes creator-fee/share support. The verifier maps that version to `solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3`. Download is running under session70433; inspect that handle/process before proceeding, do not duplicate it. No modern-source compilation or comparison result exists at this checkpoint. Public `getBlockTime(452376460)` observed deployment time `2026-10-01T19:05:48Z`; dates alone cannot identify an exact source revision.

Validation after reserved-field tightening: 257 tests/11files pass. Type annotations were corrected after the first lint/typecheck identified implicit-any Buffer callback parameters; final lint and plain typecheck pass. Source/build qualification and same-bank evidence remain unresolved; no app, signing, deploy, provider setting or funded action was performed.

## Current-source build is live

The Solana3.1.10 image download completed with the expected digest. Container `bundle-raydium-verify-3110` is now running the modern public source at `f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5` from `/root/raydium-cpmm-current-verification`, mounted at `/build`, with 4CPU/6GiB limits and `CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse`. Command: `cargo build-sbf --manifest-path /build/programs/cp-swap/Cargo.toml -- --locked`. Attached tool session:61266. The container was inspected live with network counters advancing; no modern executable or matching result exists yet. Continue by polling this exact process/container, not starting another attempt. Historical containers are terminal; historical source built successfully but both byte comparisons failed.
