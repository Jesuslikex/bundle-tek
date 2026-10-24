# Jito cancellation test scheduling

24 October 2026. Test-only fix in lib/jito-simulation-attempt.test.ts. A combined 41-file run passed 846/847 tests: the pending-fees cancellation case exhausted its helper's 200 setImmediate iterations before fixture preparation reached the mocked transport. That is not evidence of a production cancellation failure.

The two pending-phase cases now await an explicit transport-start acknowledgement before aborting and an explicit stream-cancel acknowledgement after resolving the late response. Assertions still require interrupted refusal, no body pull, unlocked stream, unchanged call count and all authority flags false. No production timeout, retry, transport or policy is changed. Other existing helper uses are untouched.

Node24.19.0: the changed cases passed in the combined 847-test rerun and in the focused 47-test controller/attempt run. Final integrated-source verification and review limits are recorded in CODEX-JITO-PREFLIGHT-OVERLAP-20261024.md. This test-only patch was independently verified by Codex; it was not included in the earlier Opus source snapshots. No deploy, provider call, hosted SQL, real wallet action or funded trade.
