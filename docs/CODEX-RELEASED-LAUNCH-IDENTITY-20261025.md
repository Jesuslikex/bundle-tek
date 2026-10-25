# Bind venue reviews to the exact published identity

Source checkpoint based on `5ff4041`, 25 October 2026. This is a prerequisite for collaborator text editing; no new collaborator permission is enabled here.

## Reproduced problem

Pump already verified the released source, image and public metadata. Meteora DBC, StonkFun and LaunchLab joined an owned release by project and release ID but used the current project's name/symbol without checking the release's retained identity. A fresh review could therefore combine current text with an older public metadata URI. Actual release creation plus disposable D1 and mocked-provider tests reproduced HTTP 200 in all three paths where stale identity should have returned 409. This concerns fresh preparation, not a bypass of existing saved-review source guards or evidence that a real transaction was sent.

## Change

`verifyReleasedLaunchIdentity` extracts the existing Pump checks and is reused by Pump and the three venue selections. It compares the same seven public identity fields: name, symbol, description, uploaded artwork reference, website, Twitter and Telegram. It verifies the released image bytes, detected/stored MIME and SHA-256 artwork identifier, then checks the metadata text, optional links and image URI against the selected release and admitted HTTPS site origin.

Funding, wallet allocation, timing and other non-identity settings are deliberately outside this identity comparison. They retain their existing independent validation. A harmless plan-setting change does not require republishing identical metadata. The helper does not compare the entire release source document to the current project.

For Meteora DBC, StonkFun and LaunchLab, the initial identity verification finishes before RPC or StonkFun pricing. It is followed by a fresh owner-scoped database read and exact row comparison, with no further async hashing after that comparison. Image data is copied to a detached number array on every read, so the comparison covers actual bytes even when the adapter returns ArrayBuffer. The same retained source/metadata/image/MIME fields participate in the existing post-simulation and pre-send barriers. A changed or unreadable identity maps to the existing venue error class with status 409.

Pump's source admission, venue/settings checks, quote/supply/precision checks, packet creation and final source barrier remain unchanged around the extraction. Malformed release JSON now has a fixed refusal message instead of exposing native parser text. Historical metadata/image endpoints, saved review reads and recovery remain unchanged; they must continue inspecting and reconciling the original retained packet after project edits or archival.

## Evidence

- The three pre-fix HTTP 200 reproductions are retained in `work/release-qa/released-identity-20261025/pre-fix-refusals.json`.
- Forty-four pure verifier tests cover exact UTF-8 identity, all seven fields, image/MIME/hash and metadata/origin failures, unrelated settings and non-mutation.
- Real-release/disposable-D1 API tests cover all seven changed identity fields, fresh current revisions, unrelated settings that remain valid and deterministic project mutation while artwork hashing is suspended. StonkFun refusal tests check both pricing and RPC remain unused.
- Standalone submit tests use synthetic fixture signatures and refuse stale descriptions before any provider/send. Existing complete mock-provider launch tests still cover their original once-only behavior. No real wallet was unlocked, signed or funded.
- Read-corruption tests preserve the immutable SQL guards while simulating changed ArrayBuffer bytes between reads, or inconsistent image/metadata output from the adapter. These verify source barriers and byte normalization; they do not claim the application can modify immutable releases.
- TypeScript AST comparisons prove all 17 existing venue preparation/submission/chain/simulation functions and their classes/constants unchanged. Pump's surrounding admission, venue/settings and complete quote/supply/packet/final-barrier tail are identical. The seven-field projection and published metadata predicate match the original Pump conditions.
- Thirteen protected parent, signing, Jito, recovery, public-release and journal files are unchanged. There is no schema change.
- Actual `claude-opus-5-5` source-only review completed with unchanged copies, zero permission denials and no blocking issue. The reviewer did not run tests. Its suggested ArrayBuffer/corrupt-read and initial StonkFun pricing assertions were added and independently tested afterwards.

Final test totals and source hashes are recorded in the companion JSON. No new browser, signed-in production, live provider or funded qualification is claimed. Application source remained stable during the broad regression run; the final two API test files were rerun after test-only review follow-ups.

## Next collaboration step

The next permission should be an explicit owner opt-in for changing only a saved project's name, symbol and description. It needs fresh server authorization, immutable default-off grants, exact revision checks, a durable mutation receipt for interrupted saves, atomic owner event history and a separate unchecked member review. Old scoped-v1 and legacy snapshots must remain view-only; the UI must distinguish a saved snapshot from a separately authorized editor. Wallets, artwork, public links, venue settings, funding, trading, publication and signing remain owner-only unless separately designed and approved. The owner would still publish changed identity before a fresh launch review; existing immutable public releases and original recovery records must not be rewritten.

## Ownership and limits

Claude PR57/59/60 application files and protected parents remain untouched. Four original unstaged AGENTS additions and seven frozen warmup drafts stay outside this checkpoint. Migration 0151 remains next unclaimed, subject to a fresh check; Claude's 0147 reservation is unchanged.

No deploy, application/hosted SQL, provider/credential/cron change, real wallet action or funded trade occurred. Full Proxima parity, delegated permissions, durable automation accounting and Jito qualification remain open.
