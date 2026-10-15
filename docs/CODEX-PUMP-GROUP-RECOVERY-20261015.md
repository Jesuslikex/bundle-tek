# Complete Pump group recovery observation

15 October 2026, based on afb4e4d. Adds a read-only observer for every packet in a complete immutable launch group. No server transition, wallet release, approval, signature creation or submission is performed.

## Behavior

The observer reconstructs the full historical review and independently revalidates all supplied signed packets and canonical evidence before RPC. Context, manifest, signed-group digest, packet hashes and flags must match exactly. A missing signed record remains explicitly unsigned; it cannot invent transaction IDs. A future owned service must validate the persisted approval/signature records and current owner/state before invoking this primitive.

Both network checks require the Solana mainnet genesis. The only permitted methods are getGenesisHash, getTransaction, getEpochInfo and getAccountInfo. The shared 20-second collection deadline also bounds non-cooperative providers, and the maximum read count is packet count plus four. No submission method, retry send, private key, provider-setting access or generic RPC dispatch is exposed.

Every supplied signed packet gets its own finalized base64 transaction read with version-1 support. Returned bytes must match that exact independently verified signed packet, with explicit error metadata and a safe slot at or beyond the reviewed source floor. Packet outcomes and known fees are retained in original order; missing fees remain null and unresolved. Known fees are totaled separately and are never replaced with simulation estimates.

If any packet is unobserved, finalized getEpochInfo links height and absolute slot at or beyond all observed receipt slots. Only height strictly above lastValidBlockHeight plus 32 allows a subsequent mint read at that bank floor. Mint observations must carry a valid context within the shared 32-slot drift bound. Present and absent accounts are parsed through the existing raw-account policy. Wall-clock review expiry alone does not establish chain expiry.

The classifications are complete (every exact packet finalized successfully), failed (every packet finalized with an error), partial (mixed success/failure or only some finalized packets), pending (no observed packet before the strict expiry margin), expired-unobserved (no packet observed after linked expiry with an absent mint), and unknown (no packet observed after expiry while the mint is present). An expired partial group remains partial, including an observed failure with unknown remaining fees.

These are provider receipt observations, not an independent economic settlement or atomicity attestation. Different finalized slots are retained rather than rejected or described as atomic. All outcomes retain settlementVerificationRequired, durableTransitionRequired and reservationsMustRemainHeld; signingAllowed, executionAllowed and completeLaunch remain false. No absence, partial observation or historical signature alone releases wallets.

## Verification

Four selected files passed all 48 tests, including 18 new observer cases and independent signature/review plus legacy single-packet recovery regressions. The retained report is work/group-recovery-tests.json. Fixtures use synthetic generated signatures and controlled RPC replies only. The non-cooperative-provider case uses a controlled deadline signal and checks the 20-second deadline argument without waiting on a real provider.

Cases cover complete, failed, mixed and non-prefix partial outcomes, exact query parameters, fees missing from finalized receipts, live and expired unknown groups, approved/unregistered observations, strict margin, partial expiry with absent mint, forged signed evidence, changed receipt bytes/encoding/metadata/fees/slots, stale height/mint banks, slot drift, wrong/changing genesis, sanitized provider errors, distinct finalized slots, cancellation and a non-cooperative read. The initial run exposed a wrong synthetic-helper import in the new test; that fixture error was corrected before this passing run.

Current-source TypeScript and two-file typed lint passed before the production build started. The production Next.js webpack build also passed; its ignored log is work/group-recovery-build.log. No existing migration or shared recovery implementation changed.

## Next

Add an owned durable group observation ledger and guarded complete/partial/unknown recovery transitions, with complete economic/receipt validation and explicit reservation-release policy. Then connect the owned API/UI and reviewed one-attempt qualified transport/tip policy. Browser-local signing and immutable signature registration exist separately; they do not qualify runtime code/authority or live v1 replay/transport. Groups over five still have no enabled execution policy.

No UI/protected Claude file, migration, remote SQL, actual provider read, credentials/provider settings, cron, push, deploy, real-wallet signature or transaction submission changed. Production remains b58355d. Main's unrelated dirty Jito note and 0068 migration are preserved. The broad Proxima parity goal remains unfinished.
