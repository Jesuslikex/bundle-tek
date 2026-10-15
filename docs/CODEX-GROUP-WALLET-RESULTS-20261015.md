# Finalized launch wallet results

Full goal remains: make Bundle like Proxima. This checkpoint adds an actual read path through the existing group API into the launch recovery UI. It does not establish full product parity.

## Reference and connection evidence

The existing approved dedicated Chrome was listening on Windows loopback port 9223. WSL had no listener. Codex restarted only the previously approved stdio/loopback relay, without launching Chrome, changing its profile/configuration, copying cookies or exposing debugging on a public interface.

REA discovery `ev_2f470ea895296b74c3ec17bc5690e29eef4bb60a78f2854cc7ac10da3fb98f29` and passive inspection `ev_39d934a06022b2acd651502cc91d8c627a6a77e3dd9ca21ecf33324e7dd6e2da` observed the existing Proxima account page on 15 October, 05:07:19 to 05:07:23 UTC. It still exposes Launch statistics, Recent launches, Best P&L, and launch/launchpad/net P&L/launched columns. This observes presentation, not the correctness of Proxima's accounting or its backend signing architecture. No navigation, click, key/storage value, script source, raw network body or transaction action was captured.

Complete REA export: `C:\Users\Julian\Desktop\REA\results\proxima-group-results-20261015-evidence.json`, two records, 242140 bytes. This contains account accessibility text and remains private outside the application repository. Do not copy reference account records or P&L figures into Bundle. Attach-limited, policy-filtered network capture remains explicitly incomplete.

Export SHA-256: `877910ee8840e5942b528b57b3849e762ea9fc3b2b4c0a6d7aca78c00f8cf121`. The approved relay remains a session process, not a scheduled service.

## Implementation

- An explicit **Read finalized wallet results** action reads only `getGenesisHash` and exact saved packet `getTransaction` receipts. The existing authenticated same-origin group route resolves the owner/project, uses the configured read-only RPC and isolates the action's rate gate. The request accepts only action and group ID, never client receipts or endpoints.
- The collector reconstructs the review, re-verifies every saved signature and exact message, then checks mainnet before and after bounded reads. Receipts must contain the exact signed bytes and a finalized slot at or above the review's source banks. The static-only account profile rejects address lookups/loaded accounts, checks complete SOL balance vectors and exact fee conservation, and refuses non-fee SOL/token changes on failed packets.
- Wallet ATAs are independently derived from each saved owner, exact mint and token program. Every available packet includes an explicit entry for every tracked wallet, even when its owner is absent from the static account list. Token attribution is checked independently through the ATA. Raw token amounts use integers, never floating `uiAmount`. Owner, program, decimals and mint attribution must match. Missing receipt/balance/identity metadata remains incomplete; absent entries imply zero only for proven absent zero-lamport accounts or addresses this static transaction cannot touch.
- The report preserves packet outcomes/fees and per-wallet SOL, created-token and non-native quote-token deltas. Known partial subtotals are labelled incomplete. Target comparisons use the saved exact-output or minimum-output amounts, not current holdings or a fabricated valuation. Finalized failures can have complete receipt coverage while clearly failing token targets.
- Client admission binds the report digest, review/context/signature vector, original wallet participation/order, exact quote precision, recomputed subtotals, coverage and target status. The UI discards delayed responses after context changes and uses existing parent busy locks. It does not unlock a vault, sign, send, change consent or release reservations. A user can export the observed public evidence as JSON.

## Limits and ownership

The separate Jito tip and its fee remain in the existing tip-aware recovery report and are excluded here. Transaction metadata is provider-attested. This report does not establish token authorities, complete pool state, Token-2022 withheld balances, gross swap spending, transaction order within a slot, bundle atomicity, audited economic settlement or P&L. It is not a live balance snapshot. All new permission/release/settlement flags stay false. Partial-outcome reservation policy is unchanged.

No product state, immutable history, migration or hosted database changes are made by the read. Reports are on demand and exportable; they are not a new persistent economic ledger. Claude's shell, token, holder/supply/timeline/performance files, shared CSS and Vitest configuration remain untouched. Preserve main's two unrelated dirty files.

## Verification

Final complete regression: **28 files, 264 tests passed, zero failures**, two parallel workers, 562.71 seconds. This includes every current `pump-group*` and `pump-launch-group*` file, actual group route unit/integration and the holder-parent UI. SHA-256 checks confirmed all edited files remained unchanged throughout the run. Typed lint, final actual-source TypeScript and the production webpack build all passed.

Earlier focused collector/API/UI run: 31 passed. Collector/orchestration/actual HTTP-SQL follow-up: 22 passed. After the explicit participant-coverage fix, 22 collector/orchestration tests passed again. Coverage includes native and SPL stock quotes, raw values beyond number precision, exact targets, fee-only failures, unknown metadata, malformed custody/mint/program/decimals, changed packet bytes/slots, SOL conservation, cancellation with a provider ignoring AbortSignal, recomputed response-digest attacks, duplicate identities rejected before RPC, owner/rate isolation and stale UI context.

Logs and frozen selection are in the Codex worktree `C:\Users\Julian\Documents\Codex\2026-10-09\https-github-com-morluto-rea-https\sites\bundle-vercel\work`: `group-effects-all-tests.log`, `group-effects-all-test-files.txt`, `group-effects-source-freeze.json`, `group-effects-lint.log`, `group-effects-types-final.log`, and `group-effects-build.log`. No funded transaction or rendered desktop/mobile qualification is established. No migration, hosted SQL, provider setting, cron, push or deployment changed.

## Claude review

Claude's existing review session `dd8b0bd0-49b3-4184-8c16-03513cc6f567` reviewed selected source read-only with no tools. Its review prompted the explicit per-packet wallet coverage fix, including when the owner is not a static key. Its duplicate-target concern was already covered by the pinned construction guard; the new test proves duplicate identities are rejected before RPC, without deduplicating the user's intent. The follow-up review hit the Claude session limit (reset reported at 7:40 am London time), so the final coverage fix has Codex verification but no second Claude sign-off. Logs: `claude-group-effects-review.json`, `claude-group-effects-followup.json`, and corresponding stderr files in the same ignored work directory. Claude did not run tests.
