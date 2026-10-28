# Jito v2 remount coverage inventory, 28 October 2026

This is a conservative mapping of the 65 expanded cases collected from `components/jito-packet-signing-remount.test.tsx`. Numbering is the exact collection order from `vitest list`. Listing tests does not run them. No existing tests were skipped, deleted, or replaced to produce this inventory. The existing remount suite is not claimed to pass against the current v2 UI. Earlier passing v2 evidence is listed below; re-run it against the final frozen source.

- **A: Passing equivalent (6).** A v2 test or a combination of separately passing UI and database checks addresses the same essential safety behavior. This does not imply identical end-to-end coverage.
- **B: Recovery-file integration needed (30).** Preserve the original scenario when migrating it to the v2 file flow. Some terminal component or journal primitives have partial isolated coverage, but the current parent does not enable that file workflow.
- **C: Intentionally changed behavior (6).** Replace the unsafe or superseded expectation with the stated v2 behavior while preserving its safety purpose.
- **D: Other v2 coverage needed (23).** Lower-level checks may exist, but the specified parent/remount scenario is not yet established by the inspected v2 tests.

## Already covered or deliberately changed

- **11:** `jito-packet-signing-v2` tests acknowledgment of a matching exact server receipt after a lost response without registering again.
- **33:** The v2 parent test blocks signing and cancellation on an exact UNKNOWN snapshot, while migration tests block submission and release. This is combined UI and database evidence, not one end-to-end test.
- **36 and 37:** V2 child tests exercise successful external swap and tip registration after durable UNKNOWN and retention.
- **47:** The v2 child tests retained swap evidence after reload, with fresh snapshot checks and separate unchecked approval.
- **65:** The v2 child tests retaining a packet when the registration response lacks an exact authenticated receipt.
- **35 and 55:** Expired signed evidence may be registered only through a separate explicit evidence approval; this never enables signing or submission. The parent has a synthetic evidence-only test; a file-to-UI end-to-end case remains needed.
- **38:** Empty external accounts after the prompt now retain a verified returned signature and refuse registration rather than accepting the old fallback. A new v2 test covers the swap case; the tip case is also covered.
- **58:** Cancellation must be blocked while an UNKNOWN attempt exists. Historical terminal inspection is a separate path and remains to be integrated.
- **63:** Encrypted local recovery replaces memory-only recovery. Browser storage loss, eviction, profile reset, and password loss still limit recovery.
- **64:** An explicitly rejected wallet prompt does not prove no signature exists; v2 retains UNKNOWN and does not reprompt.

V2 child and external helper tests were reported passing by their owner; parent, snapshot, terminal, journal, and SQL tests were run separately during development. The 65 legacy remount cases and unfinished file integration are not covered by those counts. External signer function/account mutation cases 39–46 and tip remount recovery 48 need their own explicit scenarios.

## Complete numbered inventory

1. **B** — finds an older reviewed bundle from one local file and requires history plus separate registration approval
2. **B** — finds the omitted 21st bundle while twenty distinct recent bundles are listed
3. **B** — uses an owned immutable file snapshot even if the original buffer changes during locator parsing
4. **B** — refuses duplicate keys or a different project/session before any exact-record request
5. **B** — refuses a record whose saved state changes between the two exact reads
6. **B** — preserves an unknown original outcome rather than replacing it from a file
7. **B** — refuses an older bundle when the authenticated server owner has changed
8. **B** — finds an older cancelled record for export only, with a fresh check before download
9. **B** — finds an older expired record for export only, with a fresh check before download
10. **B** — discloses an already registered matching signature without offering another registration
11. **A** — reconciles an exact signature observed in refreshed history without another registration
12. **B** — retains the original and blocks registration when refreshed history reports a different signature
13. **B** — blocks registration if refreshed history reports a different fingerprint for the same bundle
14. **D** — refuses duplicate bundle IDs in history without discarding the retained packet
15. **B** — keeps a retained packet export-only when refreshed history reports a terminal state
16. **B** — keeps the original pending if account context changes during saved-signature confirmation
17. **B** — refuses a conflicting saved signature rather than displaying the imported packet
18. **B** — does not publish a lookup result if the context changes during the owner-scoped read
19. **B** — synchronously blocks a stale cancel while lookup is reading the exact record
20. **B** — does not close a stale recovery view during a pending export
21. **B** — refuses stale registration after an in-flight history refresh fails
22. **B** — refuses stale registration when refreshed history records the signature before the POST
23. **B** — inspects a cancelled bundle recovery file through the owner-scoped exact record without signing or submission
24. **B** — inspects a expired bundle recovery file through the owner-scoped exact record without signing or submission
25. **B** — refuses terminal import when the authenticated account changes before the exact read
26. **B** — refuses terminal import if the fresh saved record is no longer terminal
27. **B** — refuses terminal import if the saved packet signature conflicts
28. **B** — retains imported packet 0 in the coordinator and blocks unsigned cancellation until explicit registration
29. **B** — retains imported packet 1 in the coordinator and blocks unsigned cancellation until explicit registration
30. **B** — blocks cancellation during imported-file validation and refuses a changed context
31. **B** — registers an imported exact packet only after a separate unchecked approval
32. **D** — blocks a stale cross-packet sign handler synchronously before any wallet prompt
33. **A** — blocks all new signing and submission while a prior wallet outcome remains unknown
34. **B** — refuses an imported packet if the server owner changes before its exact read
35. **C** — allows a verified expired import for export only, without registration, signing or sending
36. **A** — registers packet 0 after an unchanged external wallet finishes its final check
37. **A** — registers packet 1 after an unchanged external wallet finishes its final check
38. **C** — preserves the empty-account-list fallback after an external swap prompt
39. **D** — retains packet 0 but never registers when the external signer changes during the prompt
40. **D** — retains packet 0 but never registers when the external mutated signer changes during the prompt
41. **D** — retains packet 0 but never registers when the external account changes during the prompt
42. **D** — retains packet 0 but never registers when the external different account changes during the prompt
43. **D** — retains packet 1 but never registers when the external signer changes during the prompt
44. **D** — retains packet 1 but never registers when the external mutated signer changes during the prompt
45. **D** — retains packet 1 but never registers when the external account changes during the prompt
46. **D** — retains packet 1 but never registers when the external different account changes during the prompt
47. **A** — recovers packet 0 after keyed remount only after a fresh scoped history read and explicit registration
48. **D** — recovers packet 1 after keyed remount only after a fresh scoped history read and explicit registration
49. **D** — does not reveal owner A recovery under B or after A returns without a new A-scoped GET
50. **D** — refuses to open a wallet prompt when the server session changes before the fresh exact read
51. **D** — refuses to open a wallet prompt when the context changes during the fresh exact read
52. **D** — does not open a wallet prompt when the short exact-read fence times out
53. **D** — lists omitted pending metadata after scoped history and loads the exact original only on request
54. **D** — says when a fenced signer is being prepared before any prompt starts
55. **C** — offers export only after expiry, without reopening signing or submitting
56. **D** — retains the synthetic vault packet 0 across post-sign expiry without registering or sending
57. **D** — retains the synthetic vault packet 1 across post-sign expiry without registering or sending
58. **C** — offers export only if the bundle was cancelled outside this panel while the prompt was open
59. **D** — retains an external wallet response arriving after expiry without registration
60. **D** — does not allow a duplicate signature while the original wallet prompt is unresolved after a remount
61. **D** — blocks wallet signing while a cancel mutation is in flight
62. **D** — rejects a history response for a different server account before publishing any bundle
63. **C** — says that recovery is memory-only and cannot restore after the outer panel unmounts
64. **C** — releases only an explicitly rejected wallet prompt without registering or submitting
65. **A** — retains the original signature and does not publish a mismatched registration response

## Remaining test work

Complete the file recovery UI against authenticated exact v2 snapshots, then migrate the B cases with their original ownership, race, and consent assertions. Implement the D cases, including both swap and tip variants where listed. Update the C cases to assert the new fail-closed semantics; do not silently remove their safety coverage. Re-run the entire migrated suite together, plus the Jito UI, journal, server, and migration suites, before considering release. No deployment, remote migration, wallet signing, or funded test is authorized by this inventory.

