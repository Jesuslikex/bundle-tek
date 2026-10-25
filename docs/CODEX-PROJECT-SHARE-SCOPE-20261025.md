# Server-enforced read-only assignment sharing

Source checkpoint based on `109fb10`, 25 October 2026. Nothing is deployed or applied to an application/hosted database.

Project sharing already supported single-use invitations, membership, expiry, revocation and leaving. The member API still returned the entire saved project document; browser display filtering did not limit what was transported. New invitations now default to **no wallet assignment references**. The owner can explicitly load the saved project assignments and select exact chain/address/revision/role tuples for the next invite. No protected parent wiring is required.

## Behavior

- New scopes are immutable and bound to the saved project revision at insertion. SQL independently checks ownership, project revision, current assignment membership, shape, duplicate addresses and caps. Changing scope requires revoking and creating a new invitation.
- A selected reference is visible only while its chain, address, wallet revision and role still match the current saved project. New assignments, changed revisions and changed roles do not enter an existing scope. Missing references are counted as unavailable rather than substituted.
- Members receive a dedicated format-discriminated summary DTO. Hidden structured wallet references, folder metadata, identity/artwork/social URLs, cloned proofs and Pump fee-share addresses are omitted before transport. Plan text, public quote contracts, settings and aggregate counts remain visible; this is not a promise to redact arbitrary addresses someone types into freeform text.
- Existing NULL scopes remain explicitly labelled legacy and retain their prior all-current-assignment visibility. Owners can revoke and reinvite to limit that access. New NULL scopes and conversion/widening of existing scopes are refused.
- Historical assignments can be on a different chain after a plan edit. They are unavailable for the new plan without breaking owner revocation or read-only inspection. An invalid source becomes unavailable to the owner; a corrupt share scope is labelled unavailable while Revoke remains usable. Member corruption fails the complete response closed rather than silently omitting a row.
- The picker makes no request on mount or expansion. Loading clears selection, and context changes discard old responses. Checked references are for the next invite only. Existing lost-invite guidance remains: refresh and revoke an unused invite before retrying; an unrecoverable one-time token is not automatically recreated.
- Expiry and revocation stop future reads. They cannot erase previously viewed or copied data.

This implements read-only assignment visibility, **not** collaborator editing, trading, transfers, wallet control, re-sharing or key export. Existing project/wallet/financial APIs remain owner-only. Saved references do not prove current balances, custody, independent ownership or launch readiness.

## Verification

- 186 related tests across eight contract, DTO, route and component files pass on Node 24.19.0. Coverage includes hidden-address transport, stale/foreign/duplicate grants, exact checksummed EVM references, legacy and none scopes, changed chains/revisions, corrupt-scope revocation, expiry and cancellation/context races.
- Plain TypeScript, twelve-file typed lint and fifteen-file formatting pass.
- Source guards compare nine protected project/wallet/Auto Sell/group-runtime files against the base. The existing accept/revoke/leave handler tail is unchanged. All 148 prior SQL files are unchanged.
- Actual whole-file Wrangler applies all 149 journal migrations in disposable D1. A separate native SQLite upgrade from 148 to 0150 preserves all prior ledger rows and seeded values across 183 tables, matches all 149 canonical checksums and passes integrity/foreign-key checks. Twenty-five guarded SQL cases cover valid and invalid scopes, source drift, immutability, legacy protection, replacement refusal, acceptance, revocation and naturally expired invitations. No guards were dropped. The native fixture advances a controlled SQL clock; it does not change production time.
- Actual compiled owner/member components call the real sharing route and production SQLite adapter against a disposable database containing all 149 migrations. Synthetic owner selection, invite, member acceptance, inspection, owner revocation and a fresh empty member read pass. Recorded POST actions are only invite, accept and revoke. Serialized member JSON contains exactly the selected public reference and no hidden structured references/private links. This is not signed-in production or provider/funded proof.
- Desktop 1920px and phone 375px owner/member layouts show no horizontal overflow. The test tabs and owned local server were closed. Application globals and current component utility/module styles were compiled for this fixture.
- Two actual `claude-opus-5-5` source-only reviews completed with unchanged copies. The first identified the historical-chain revocation regression; it also encountered three denied reads outside its bounded copies. The second reviewed explicit dependency copies, recorded zero permission denials and found no concrete blocker after fixes. Root independently confirmed that the unchanged project save path stores normalized `validateProjectDocument` output; the EVM route test also verifies exact SQL admission. Final wording and additional tests were independently checked after the review. Opus did not run tests.

Private evidence: `work/release-qa/share-scope-guards-20261025.json`, `share-scope-browser-20261025/`, `share-scope-migrations-20261025/` and the two `opus-share-scope-*` folders. Initial verifier-only object-prototype comparison failure is retained separately; both migration paths were rerun successfully against final SQL.

## Release and ownership

New source-only migration `0150_project_share_scope` has journal index 148 and timestamp `1794860000011`. Its checksum is `7a382ea385b469d85300c4dfda67afb23918721d12c369f5cfa858bc624ef9aa`. Claude's reserved 0147 still needs insertion before published 0148/0149/0150 when merged; do not rewrite published SQL, timestamps or checksums. Next unclaimed migration is 0151, subject to a fresh check.

Claude PR57/59/60 application files, protected parents, four original unstaged AGENTS additions and seven frozen warmup drafts remain untouched. No application/hosted SQL, provider/credential/cron change, real wallet action, funded test or deployment occurred. Source Git deployments remain disabled.

Full parity remains incomplete: delegated collaborator permissions, durable automation accounting/execution continuity, remaining marketplace payment fixes and full Jito runtime/program qualification remain open. The member list retains its existing bounded whole-response behavior; very large inventories can still exceed the client response cap and fail visibly rather than returning partial evidence.
