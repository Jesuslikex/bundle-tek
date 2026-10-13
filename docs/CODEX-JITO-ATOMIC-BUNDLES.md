# Jito atomic bundle flow

Implemented locally on 2026-10-12 in `C:\Users\Julian\Desktop\Bundle`.

## User flow

Open an imported Solana token, expand **Wallet groups and bundle sessions**, and save a Buy or Sell session with exact wallet amounts. Each saved session has a **Jito atomic bundle** disclosure.

1. Choose one to four current, unreserved session wallets. Scheduled entries must already be due; paused/cancelled sessions cannot prepare or submit.
2. Enter an explicit tip of 1,000 to 10,000,000 lamports. The first wallet pays the tip and its network fee in a final separate transaction.
3. **Prepare and review selected Jito swaps** prepares the group together. The bounded group shares the existing provider-read gate and preserves short quote validity. Each wallet still gets its own balance checks, wallet-bound quote, strict route/instruction/settlement simulation and saved preparation/approval.
4. Review the immutable ordered manifest, fees, native debits, output bounds, tip payer/recipient and expiration. Each packet has a separate unchecked signing consent and signing action. Encrypted browser vault and Wallet Standard external signing are supported; there is no automatic wallet unlock or combined sign-and-send call.
5. After all swaps and the tip are signed and registered, a separate unchecked consent enables **Submit complete Jito bundle**. Submission checks current project/wallet revisions, session state/timing, exact packets, simulation/settlement, tip recipient, tip balance and validity again.
6. **Check chain outcomes** recovers signatures without sending anything. An acknowledgement is not landing or finalization. Finalized status requires every exact packet to succeed in the same finalized slot, an exact tip packet and saved verified swap receipts. Jito status, when returned, must match the full ordered signatures and slot.

Existing unbundled unsigned session approvals can also be loaded and attached to a manifest. They must still be fresh. Group preparation is the practical default because ordinary quotes can have a 30-second validity window. The app does not extend provider quote expiry to accommodate slow signing.

## Limits and invariants

- A bundle contains at most five transactions: one to four swaps followed by one tip. A larger 25-wallet session is not secretly split and labelled as one atomic bundle.
- The first wallet must cover its own maximum swap debit, tip, both fees and reserve without relying on earlier bundle proceeds.
- Each transaction remains independently signed. Signed packets are public transaction data and are retained only in owner-scoped bundle storage; private keys remain in the browser vault or external wallet.
- Transaction order and the complete manifest have one SHA-256 fingerprint. Registration is exact, signature-verified and idempotent. Individual registration/cancellation/submission is guarded after membership is recorded; individual receipt recovery remains available.
- SQL stores membership and manifest atomically. Attachment races with signing/cancellation/context changes roll back. SQL keeps bundle terms, packet identities, signed packets and bundled preparations immutable. Submission claims all member intents and reservations in the same transaction.
- One submission transport attempt is reserved before `sendBundle`. A timeout, rejected response, malformed acknowledgement or storage uncertainty retains `submitting`; it never enables an automatic resend or fallback to ordinary `sendTransaction`.
- An entirely unsigned bundle can be cancelled. Signed bundles require recovery. Expiry release requires the finalized block height to exceed every packet's last-valid height, all retained signature statuses to be absent, and finalized transaction reads to return null. This is an observation from the configured RPC, not proof of complete historical provider coverage.
- Partial, failed, processed or inconsistent observations cannot establish atomic success. Reservations remain for receipt recovery when evidence is incomplete.
- Bundles are limited to 20 retained records per project. Preparation history retains the existing 200-record limit. No unattended scheduler or additional chain/venue launch execution was added.

Jito describes sequential, same-slot, all-or-nothing bundle execution, a five-transaction limit, a required tip, and an acknowledgement that does not guarantee landing. Its uncled-block guidance also explains that rebroadcasts can break bundle isolation. The UI therefore does not promise unconditional atomicity. Source: [Jito's official transaction and bundle documentation](https://docs.jito.wtf/lowlatencytxnsend/).

## Files and local storage

- `lib/jito-bundle.ts`: manifest fingerprint, bounds, validation and ordered status matching.
- `lib/jito-provider.ts`: fixed HTTPS Jito endpoint, bounded JSON-RPC, no client-supplied endpoint.
- `lib/jito-bundle-preparation.ts`: fresh group preparation and cleanup of only new unsigned approvals on partial failure.
- `lib/jito-bundle-server.ts`: owner-scoped creation, registration, one-shot submission, cancellation and recovery.
- `app/api/imported-projects/jito-bundles/route.ts`: authenticated API, origin/JSON/payload checks, explicit approval flags and provider rate gate.
- `components/jito-atomic-bundle.tsx`, `components/jito-packet-signing.tsx`: full-group review, individual signing and separate submission.
- `components/imported-trade-sessions.tsx`: narrow per-session integration.
- `app/api/imported-projects/signing/route.ts`: narrow individual registration/cancellation guards; migration submission trigger blocks individual sends for bundled members.
- `db/jito-bundle-schema.ts`, `drizzle/0068_remarkable_frightful_four.sql`: manifest and ordered packet storage plus transactional guards. Migration applied to local D1 only. Production migration/deployment remain outstanding.

Claude-owned `components/imported-supply-tracker.tsx`, `components/imported-holder-view.tsx`, `lib/supply-watch-wallet.ts` and watch-wallet fixtures were not edited.

## Verification and remaining proof

### External swap signature retention follow-up

The Jito external swap signer now supplies an optional verified-packet retention callback to `signApprovedExternalWarmupPacket`. Exact message bytes, canonical packet encoding, signer count and the reviewed wallet signature are checked before retention. Retention happens before rejecting a wallet/account/approval change after the extension prompt. Other callers retain their earlier behavior when no callback is supplied. This matches the existing Jito external tip recovery ordering.

The Jito component retains the packet in its pending state before attempting server registration. A registration failure leaves a read-only packet field and registration-only retry available. This field is session-local; it does not establish durable recovery after closing the page. Server context/expiry guards remain authoritative. No resend, second signature request, submission or fallback is introduced.

### User-controlled recovery files

Pending packets can now be downloaded as a bounded JSON recovery file. After loading the same saved bundle again, use the unsigned packet's recovery disclosure to import its file. Import verifies locally and only restores pending state; the user must separately choose registration-only retry. A file matches the project, session, bundle fingerprint, zero-based packet position and cryptographically verified exact signed transaction. Swap validation uses the same browser-safe `exact-swap-signature` helper re-exported by the existing server module; tip validation uses the existing native withdrawal inspector.

The file limit is 4,096 bytes. Private keys/passwords/full vaults are absent. A signed packet can be broadcast by someone possessing it, so the download and import controls explain that files should remain private. No automatic disk storage, upload, signing, submission or resend is introduced. Expiry does not prevent local recovery validation; server state and owner checks still govern registration and submission. Durable recovery here depends on the user saving the file before closing the page; automatic after-close monitoring remains incomplete.

Forty-one focused tests pass across file recovery, external signing, bundle validation and server behavior. These include expired import, all identity mismatches, unsigned/altered packets, extra fields, size/position bounds and existing server registration guards. TypeScript and scoped lint also pass. Rendered export/import/reload interaction and funded recovery remain unverified.

Thirty-one focused tests passed across external swap signing, native external withdrawal signing, bundle validation and bundle UI structure. Added regressions cover changed account/feature/expiry/scope, altered message/signature rejection before retention, and retention failure without requesting another signature. This change follows the frozen 1,829-test full-suite snapshot and is not covered by that earlier result. Current interactive and funded recovery proof remains outstanding.

- 68 focused tests passed across 17 files. Includes group preparation, partial preparation cleanup, four-wallet/five-packet claiming, cross-owner rejection, exact packet/signature binding, immutable order, duplicate registration/submission, altered context, pause guards, unsigned cancellation, unknown transport outcome, same-slot finalization and expiry recovery, plus existing signer/session tests.
- Existing imported signing route/session/conditional regression suites: 84/89 passed on the initial run. Five route failures followed a local Miniflare connection exhaustion (`EADDRINUSE`); six matching cases passed when rerun in isolation. No test assertion was weakened.
- TypeScript and scoped lint passed. Production build passed; existing large-client-chunk warning remains.
- Read-only live `getTipAccounts`: HTTP 200, eight accounts, no JSON-RPC error. This establishes endpoint availability only.
- Isolated browser QA used production components, four synthetic wallets and five explicitly approved synthetic packets. It exercised both unknown and accepted submission responses, separate submission consent and absence of a resubmit control after an unknown result. All provider access and real submission were disabled in that harness.
- Phone QA at 390px: document client/scroll widths both 375px after scrollbar allocation. Desktop/mobile screenshots were inspected and saved in the chat workspace as `outputs/jito-bundle-desktop-qa.jpg` and `outputs/jito-bundle-mobile-qa.jpg`.
- Real local integration: saved a public-wallet-only BONK QA session, opened its production Jito panel, and loaded owner-scoped history successfully through the actual local API. No preparation was requested. The QA session `b3517fbc-9d97-413c-984f-039ee1e2dc65` was then cancelled, with zero approvals/signatures/trades. Screenshot: `outputs/jito-bundle-integration-qa.jpg` in the chat workspace.

No real user wallet was unlocked, no real signing prompt was requested, and no mainnet bundle was submitted. A funded mainnet test remains unverified and requires the user to perform the final wallet approval and financial submission. Full Proxima parity remains incomplete.

Retention follow-up terminal validation: TypeScript, scoped lint and production build all completed successfully. Claude's protected components, watch helper, warmup history tests and Vitest configuration retain their prior modification times. No live signing, registration or transaction submission was performed.


Recovery-file production build completed successfully after the final UI/helper changes. This remains local engineering verification, not interactive download/reload proof.

# Retained finalization evidence, 12 October 2026

Recovery linkage is now stricter: the imported-approval adapter returns the actual saved receipt rather than a boolean. Bundle recovery requires its project/preparation identity, wallet, mint, side, network, finalized commitment, verified signature, packet fingerprint and slot to match the manifest and ordered packet being recovered. A callback returning true or a truthy unrelated receipt cannot finalize the bundle. Ten focused receipt/transport/API-adapter tests passed; the slot-301 receipt versus slot-300 bundle case preserves submitted state and creates no finalization record. TypeScript, scoped lint and the production build passed. Claude's signing files were not edited.

Newly recovered finalized bundles now retain a separate immutable finalization receipt. It captures the observed common finalized slot, exact ordered signatures, bundle fingerprint, observation time and receipt SHA256. The existing recovery checks still require successful finalized statuses for every packet, exact finalized tip bytes and successful saved-swap recovery before the receipt/state transaction commits. Missing, partial, failed, unsafe slot or conflicting evidence does not produce a new receipt. This is retained provider-observation evidence and an integrity digest, not an independent cryptographic proof of the chain or unconditional atomicity.

Receipt insertion and finalized state update use one D1 batch. Reads revalidate the receipt digest, fingerprint and ordered signatures. The review UI displays the slot, receipt fingerprint and observation time; legacy finalized records without this additional evidence explicitly say it was not retained. Schema-only migration 0070 adds the receipt table and binding/immutability/retention triggers without backfilling older outcomes. The main journal now has seventy-one migrations; the separate hosting candidate remains unchanged.

Fourteen focused receipt/transport/registration/event/review/migration tests passed, including persisted reload, immutable receipt rows, ordered-signature and digest tampering rejection, and the full journal on disposable native SQLite and Miniflare D1. TypeScript, scoped lint and the final production build passed. No user wallet was unlocked, signed or submitted; mocked transport tests do not establish live funded execution.
