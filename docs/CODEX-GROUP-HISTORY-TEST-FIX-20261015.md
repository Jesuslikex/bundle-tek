# Complete group test contract correction, 15 October 2026

Claude's desktop session reported a failure in `lib/pump-launch-group-review-service.test.ts` and requested a complete run of both group-test filename families. Codex reproduced the named test alone at `763c9cb` before editing. The actual diff contained the history page's additional `createdAt`; `receipt: null` was already present on both expected and actual reviews.

The test now explicitly asserts the new unsigned review has a null receipt. Its exact page-result comparison additionally includes `createdAt` read independently from the owned saved database row. The assertion remains exact; it was not weakened to ignore extra fields. Production code and permission boundaries are unchanged.

Codex's previous 12-file targeted run did not include this service file. This correction uses every file discovered under `lib`, `test`, `app` and `components` with either `pump-group*.test.*` or `pump-launch-group*.test.*`. Discovery found exactly 20 files; the selected list is retained in ignored `work/group-complete-test-files.txt`. Codex runs these tests itself. The read-only CLI reviewer did not execute them.

Verification: standalone pre-fix reproduction failed as reported. The complete final run passed **20 files and 194 tests, zero failures**, in 408.79 seconds. Its log is `work/group-complete-receipt-fix-tests.log`. Typed lint for the changed test passed. No production build or migration rerun is needed for this test-only correction.

Only this note and the owned service test are included in the checkpoint. Claude-owned files and main's two unrelated dirty files are preserved. No credentials/provider change, hosted SQL, wallet signing/submission, push or deployment occurred.
