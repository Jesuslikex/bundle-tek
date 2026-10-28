# Jito v2 remount coverage inventory, 28 October 2026

The migrated `components/jito-packet-signing-remount.test.tsx` suite now passes all 65 expanded cases. On the unchanged source used for final verification, the combined Jito run passed 222 tests, including those 65. The original numbered inventory below is retained verbatim as a historical mapping of the previous 65 collected case names, not a claim that every current test keeps its former wording or old behavior.

The earlier A/B/C/D markers record the original inventory's classifications, not remaining work counts. Cases that were marked B or D have since been migrated and executed. No case was silently dropped to obtain the 65-case run. Migration updated fixtures and assertions to the v2 contract, including deliberate changes below.

- **Expired evidence (historical cases 35 and 55):** exact already-signed evidence can be registered after expiry only after separate explicit approval, or privately exported. Neither action enables signing or submission.
- **Disappearing external wallet account (38):** a returned exact packet is retained, but registration is refused when the expected account is no longer visible; there is no empty-account fallback.
- **Cancellation while outcome is unknown (58):** the impossible cancellation is refused and the signed evidence is retained. Terminal record inspection/export is separately read-only.
- **Recovery storage (63):** encrypted local journal recovery replaces the former memory-only expectation. A fresh owner-scoped exact read and explicit consent are required; lost browser storage or password remains a limitation.
- **Rejected prompt (64):** an explicit rejection does not prove no signature was produced. The durable attempt remains UNKNOWN and is not automatically retried.
- **Historical cases 15 and 20:** the migrated assertions now test conflicting terminal state while UNKNOWN and preservation of the recovery view during export, respectively. These changed names are intentionally disclosed here.

These are synthetic tests using wallet, storage, network, time or Web Lock doubles. They do not establish actual browser IndexedDB/Web Locks behavior, live RPC or Jito behavior, chain settlement, or funded execution. The run is evidence for the tested source at the time of verification, not by itself authorization to deploy or trade.

## Complete numbered inventory

1. **A** — finds an older reviewed bundle from one local file and requires history plus separate registration approval
2. **A** — finds the omitted 21st bundle while twenty distinct recent bundles are listed
3. **B** — uses an owned immutable file snapshot even if the original buffer changes during locator parsing
4. **B** — refuses duplicate keys or a different project/session before any exact-record request
5. **B** — refuses a record whose saved state changes between the two exact reads
6. **B** — preserves an unknown original outcome rather than replacing it from a file
7. **A** — refuses an older bundle when the authenticated server owner has changed
8. **B** — finds an older cancelled record for export only, with a fresh check before download
9. **B** — finds an older expired record for export only, with a fresh check before download
10. **A** — discloses an already registered matching signature without offering another registration
11. **A** — reconciles an exact signature observed in refreshed history without another registration
12. **B** — retains the original and blocks registration when refreshed history reports a different signature
13. **B** — blocks registration if refreshed history reports a different fingerprint for the same bundle
14. **A** — refuses duplicate bundle IDs in history without discarding the retained packet
15. **B** — keeps a retained packet export-only when refreshed history reports a terminal state
16. **B** — keeps the original pending if account context changes during saved-signature confirmation
17. **B** — refuses a conflicting saved signature rather than displaying the imported packet
18. **A** — does not publish a lookup result if the context changes during the owner-scoped read
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
31. **A** — registers an imported exact packet only after a separate unchecked approval
32. **D** — blocks a stale cross-packet sign handler synchronously before any wallet prompt
33. **A** — blocks all new signing and submission while a prior wallet outcome remains unknown
34. **A** — refuses an imported packet if the server owner changes before its exact read
35. **C** — allows a verified expired import for export only, without registration, signing or sending
36. **A** — registers packet 0 after an unchanged external wallet finishes its final check
37. **A** — registers packet 1 after an unchanged external wallet finishes its final check
38. **C** — preserves the empty-account-list fallback after an external swap prompt
39. **A** — retains packet 0 but never registers when the external signer changes during the prompt
40. **A** — retains packet 0 but never registers when the external mutated signer changes during the prompt
41. **A** — retains packet 0 but never registers when the external account changes during the prompt
42. **A** — retains packet 0 but never registers when the external different account changes during the prompt
43. **A** — retains packet 1 but never registers when the external signer changes during the prompt
44. **A** — retains packet 1 but never registers when the external mutated signer changes during the prompt
45. **A** — retains packet 1 but never registers when the external account changes during the prompt
46. **A** — retains packet 1 but never registers when the external different account changes during the prompt
47. **A** — recovers packet 0 after keyed remount only after a fresh scoped history read and explicit registration
48. **A** — recovers packet 1 after keyed remount only after a fresh scoped history read and explicit registration
49. **A** — does not reveal owner A recovery under B or after A returns without a new A-scoped GET
50. **A** — refuses to open a wallet prompt when the server session changes before the fresh exact read
51. **A** — refuses to open a wallet prompt when the context changes during the fresh exact read
52. **A** — does not open a wallet prompt when the short exact-read fence times out (simulated aborted signal)
53. **D** — lists omitted pending metadata after scoped history and loads the exact original only on request
54. **D** — says when a fenced signer is being prepared before any prompt starts
55. **C** — offers export only after expiry, without reopening signing or submitting
56. **A** — retains the synthetic vault packet 0 across post-sign expiry without registering or sending
57. **A** — retains the synthetic vault packet 1 across post-sign expiry without registering or sending
58. **C** — offers export only if the bundle was cancelled outside this panel while the prompt was open
59. **A** — retains an external wallet response arriving after expiry without registration
60. **A** — does not allow a duplicate signature while the original wallet prompt is unresolved after a remount
61. **A** — blocks wallet signing while a cancel mutation is in flight
62. **D** — rejects a history response for a different server account before publishing any bundle
63. **C** — says that recovery is memory-only and cannot restore after the outer panel unmounts
64. **C** — releases only an explicitly rejected wallet prompt without registering or submitting
65. **A** — retains the original signature and does not publish a mismatched registration response

## Remaining work and boundaries

Perform signed-in real-browser verification of the integrated v2 flows, including actual browser storage, owner changes, remounts, Web Locks and timeout behavior. Verify any provider-specific qualification separately without weakening checks. Review rollout for legacy bundles and clients already loaded before a migration: legacy records remain read-only where exact signing state is ambiguous, and a cached older client may already have opened a wallet prompt. Do not infer a no-signature outcome from UNKNOWN or from missing local evidence.

The 222-test combined run is synthetic and does not prove live Jito delivery, finalized on-chain outcomes, successful recovery from every browser-storage loss, or a funded end-to-end launch. Any remote migration, production deployment, real signing, submission or funded test requires its own authorized release and verification process. Preserve the existing consent and fail-closed safeguards.
