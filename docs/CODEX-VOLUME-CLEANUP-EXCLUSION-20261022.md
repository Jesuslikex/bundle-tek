# Same-block Volume and cleanup wallet exclusion

22 October 2026. Source base8069c051cff74345082733087a7cd7ede67821d5. This is local source and disposable verification only.

Cleanup and same-block Volume reservations could coexist on the same owned wallet. The baseline through0137 reproduced three failing assertions among five tests. New additive0138 installs four owner/address-scoped guards: bundle reservation admission, first attempted marker, cleanup admission and cleanup transition to signing/submitted. Cleanup awaiting_signature/signing/signed/submitted blocks Volume; Volume held/attempted blocks cleanup. Expiry does not remove either hold. Different owners and unrelated wallets remain independent. Existing committed migrations and all application route/signing/runtime code are unchanged.

The full-schema fixture constructs a reservation through the actual unsigned runtime validator with controlled RPC and a synthetic program policy. It does not drop guards or forge verified flags. Matching historical retries return the original disabled reservation without RPC or another hold. Attempt markers remain metadata, not signing/send permission. No live same-block execution integration is asserted.

The real cleanup POST tests prove an atomic multi-wallet begin_signing rollback and exact409 error mapping before send. A legacy no0138 control reaches only a fake send; applying0138 returns409 with the original signed packet retained and zero sends. Synthetic published test keys supply packets only in the test process. No real key or provider is accessed. Real cleanup receipt recovery under a legacy Volume hold remains possible: missing receipt retains signed state and the hold; exact finalized receipt permits the later Volume attempt marker, still with both authority flags false. Reverse Volume recovery uses the real packet/accounting decoder, retains unresolved exposure and records finalized settlement without resending, after which cleanup may proceed. Attempted bundles block both cleanup signing and submission.

## Verification

- Baseline: five tests, two pass and three fail, proving the missing exclusion.
- Final integrated seven-file cohort:184pass, zero failures/skips. Subsequent final two-file rerun:21pass, zero failures/skips, including two additional attempted-state cases.186distinct cases overall; these are focused checks, not a full suite.
- Plain TypeScript, four-file typed lint and formatting pass after the final test changes.
- All139 checksum-runner migrations apply in a fresh disposable local database;139checksums match current source, integrity is ok and foreign-key check is empty.
- Real whole-file Wrangler4.127.1 local migrations apply139/139. Every SQL file hash still matches that report. This validates local D1 migration execution, not hosted state or runtime load.
- Actual claude-opus-5-5 source review completed with19unchanged copied files, Read/Glob/Grep only, zero permission denials. Reviewer ran no tests/browser and did not receive the journal. It found no SQL defect and requested attempted-state, actual route rollback/send and reverse recovery proof; Codex added and verified those afterward. The four-guard SQL remains identical to the reviewed copy. Final test changes are independently verified, not claimed reviewed by Opus.

Reports are ignored local artifacts in work/release-qa: volume-cleanup-gap-20261022.json, volume-cleanup-final-complete-20261022.json, volume-cleanup-final-followup-20261022.json, volume-cleanup-ledger-20261022.json and opus-volume-cleanup-exclusion-20261022. Portable summary and source hashes are in the companion evidence JSON.

## Release and remaining boundaries

Do not apply this to the application or hosted database without a separate approved release and checksum/legacy conflict inspection. Existing simultaneous signed/attempted work can remain conservatively blocked. Cancel only an eligible never-attempted reservation through its existing exact cancellation path; attempted markers cannot be cancelled as if unsent. Missing transaction history or expiry is not proof of non-broadcast. No automatic release, purge, first-sender choice or retry is added. If finalized evidence remains unavailable, retain the hold.

No UI, provider/credential/cron, application/hosted database, real wallet unlock/sign/send, strategy run, funded test or deployment occurred. Preflight provider work may precede the final storage conflict; this change does not add an early read optimization. Owner-scoped exclusion is not a global public-key mutex across accounts. It does not qualify the production program policy, enable same-block signing, complete durable warmup execution, prove full-family conformance or establish Proxima parity.0138 freezes at its first commit; next free0139 subject to journal/claim recheck.
