# Wallet-family exclusion prerequisite

22 October 2026. Source base e08ee5c. New0137 is a local source candidate, not an applied application/production migration or an enabled warmup runner.

## Reproduced issue

On all unchanged migrations0000–0136, positive storage admissions succeeded for cleanup, supply actions, organic sequences and scheduled Volume. Organic and Volume excluded each other, but ten other directed pairs admitted overlapping owned wallets. The new regression cohort first recorded30passes/10failures. Cleanup and supply HTTP prepare paths check their own family and the central registry before provider work, but those preliminary reads cannot atomically prevent another family's later insertion. No funded exploit or full HTTP admission for every family is claimed from direct SQL fixtures.

## Additive guard

0137 adds two read-only views and guards. It does not change stored budgets, packets, consents, program decoders, authorization lifetimes, provider settings or application signing code.

- Cleanup/supply pending states remain awaiting_signature, signing, signed and submitted. Active organic/Volume plans retain all selected wallets. After a session stops, any signed/submitting/submitted child retains the full selected set, matching the older central reservation checks. Actual unresolved child wallet rows are also retained.
- Conflicting new admissions fail inside the same SQLite statement; rollback leaves no partial source/event/bridge. Independent owners/addresses remain independent. Duplicate supply admission also receives a reserved error, but the older active-wallet uniqueness constraint already provided a safeguard, so this is not counted as a new gap closure.
- Before-sign/send state claims recheck the four-family view and the central execution registry. Real routes mark submitted/submitting before RPC, so refusal precedes broadcast. Cleanup's same-batch sell/close and Volume's own Buy/Sell remain compatible. Organic can prepare its next batch while the prior batch is submitted under the same saved sequence.
- Batch INSERT checks an active owned parent and conflicts before a new signing review. Signed row INSERT binds owner, batch and membership in the saved plan's wallet set. It does not independently validate the exact per-index review, amounts, code or signature; existing application verification remains mandatory. Already-signed evidence is not discarded merely because a competing hold exists.
- Terminal sessions cannot reactivate. Organic identity/plan fields and Volume's missing id/creation-time identity fields become immutable. Existing Volume plan immutability remains. Shared reservation wallet/owner UPDATE cannot move a hold onto these busy wallets. Old per-family shared INSERT guards remain; a redundant new shared INSERT trigger was removed after review.
- Stop, unsigned cancellation, finalized/failed receipt transitions and retained history are preserved. No automatic retry, expiry release, first-wins dispatch or forced failed status is introduced.

The view covers these four families, not every Solana execution source. Existing launch, pair, Jito, bundle, counter, nuke and common-swap rules are not globally replaced or independently cleared by this patch. Auto Buy0136 accounting claims remain non-executable and are not reclassified as physical sends.

## Legacy signed conflicts and release hold

Upgrade does not delete or choose among existing conflicting records. Two legacy signed approvals can remain blocked until an independently verified outcome is available. A signed application state is not proof that a packet was never broadcast elsewhere, and absent provider history is not proof of non-landing. Do not solve this by deleting reservations, changing states, resending or loosening checks.

Before a production release, inspect the actual ledger/checksums and retained cross-family conflicts with separately authorized read access. If unresolved signed conflicts exist, stop that release and agree on receipt-based reconciliation first. No production inspection or data repair occurred here.0137 must not be applied remotely merely because local tests pass.

## Actual verification

- Final146tests/sevenfiles pass, zero failures/skips. Includes95new full-schema storage cases and7new HTTP cases plus44existing bridge/route/service tests. Positive fixtures are SQL-valid storage parents, not real packet/provider/funded proof.
- The supply HTTP tests run the actual unsigned review/balance/program and finalized receipt decoders against controlled RPC responses. They inject each family after preflight and before retention, prove409 with no partial row/event, and compare the legacy control's fake send with the guarded exact “already reserved” refusal. Null recovery stays signed/reserved; an exact synthetic finalized receipt still records with a competing cleanup present. Only a published deterministic test key is used. Real fetch is forbidden; no actual wallet/provider/send is available.
- Full local checksum-checked runner applies all138migrations to a new disposable file. A read-only local ledger audit finds138matching checksums, no pending/mismatch, integrity ok and no foreign-key errors.
- Final whole-file Wrangler `d1 migrations apply --local` applies138/138. Its copied0137hash matches current source. First candidate failed on localD1's five-term compound SELECT limit, independently probed with five succeeding and six failing. Final views have4and3terms and retain every hold predicate. No committed earlier migration was rewritten.
- Six actual localD1 runtime scenarios prove cleanup admission, opposing supply refusal, no partial row/event, explicit unsigned cancellation, later supply admission and retained source history. A representative EXPLAIN QUERY PLAN uses owner and batch indexes; this is not a load/latency benchmark or proof for every query.
- Additional full localD1 exercise applies137baseline migrations, seeds SQL-valid legacy conflicts, upgrades with0137 and verifies23stages: initial/upgrade/ledger plus19expected refusal cases covering all17new triggers. The final ledger has138entries. This is storage/runtime evidence, not a real-wallet or funded run. The promoted reusable scripts/check-wallet-family-0137-d1.mjs also completed its own fresh23-stage run successfully, with a new temporary database and no source edits afterward.
- Plain TypeScript, three-file typed lint and formatting pass. The local-only reproduction script also passes syntax/lint checks. No full-suite, production build, browser UI or funded qualification is claimed for this database-only change.

Ignored local receipts are in work/release-qa/wallet-family-exclusion-final-verified-20261022.json and work/warmup-wallet-exclusion-20261022/. Portable counts, source hashes and review provenance are in the sibling evidence JSON.

## Actual Opus5.5 review

Two completed source-only reviews used only claude-opus-5-5 and Read/Glob/Grep, with149and17copied files unchanged and zero permission denials. They did not run tests, providers, wallets or browsers. The first review drove batch/member checks, full-plan unresolved holds, reactivation bans, extra central checks and regression cases. Codex rejected the suggestion that a signed state proves non-broadcast; conservative holds remain. The second found no blocking/high issue and requested stronger evidence. Codex then independently ran final-source D1 apply/runtime checks, added the exact refusal/control and organic multi-batch tests, and inspected the actual D1 query plan. Those last test-only follow-ups were not rereviewed. Logs are ignored opus-wallet-family-exclusion-20261022 and sibling -final- directories.

Remaining pre-existing limitations include misleading organic/Volume conflict copy, provider work before a final SQL refusal, empty closed Volume bookkeeping batches also refusing a legacy conflict, malformed legacy JSON failing closed, and same-block Volume/cleanup cross-family integration. Views must be explicitly dropped/recreated if a later migration rebuilds their parent tables. Full cross-family execution conformance, new warmup consent/root/CAS/receipt-lot projection/reconciliation and live runtime qualification remain open. Full Proxima parity is unproven; keep the goal active.

## Reproduce locally

From the Bundle checkout with its existing dependencies: run `node scripts/check-wallet-family-0137-d1.mjs`. It always creates a new disposable database, invokes Wrangler with `--local`, retains logs/report in its returned temporary folder, and refuses unexpected failures. It specifically checks the0136-to-0137 upgrade, not future migrations. `node scripts/check-wrangler-migrations.mjs` separately checks the whole current journal. Every database engine call is explicitly local; the probe does not configure providers, use wallets or change credentials. The probe uses synthetic storage records and must not be treated as financial admission or signing proof.
