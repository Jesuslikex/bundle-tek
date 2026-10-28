# Jito v2 older bundle locator

This local draft connects the reviewed older-bundle locator to the Jito parent. It keeps the 20 recent history records intact and stores an opened older bundle and its verified snapshot separately. The locator uses an owner-scoped exact read and local signature verification; locating a file neither signs, registers, nor submits a transaction. The user selects the file again in the packet panel and separately approves any exact evidence registration. Legacy bundles remain read-only.

The parent invalidates snapshots on context or operation changes and applies a five-second deadline through asynchronous exact-snapshot and signed-packet verification. Account, session or timeout changes leave the old record unavailable for action. The application's existing navigation and unsaved-draft guards were not changed.

## Verification and limits

- Three locator, parent/locator and parent/file test files passed, 28 cases total, using synthetic wallet, storage, lock and server fixtures. Coverage includes opening a 21st record without evicting the 20 recent ones, exact file registration with separate consent, legacy read-only, stale owner, stale parent session during a pending exact read, and a locator timeout.
- These tests do not establish real-browser IndexedDB or Web Locks behavior, signed-in production behavior, provider compatibility, funded execution, or complete Jito qualification. The complete legacy remount suite remains a separate migration and is not claimed to pass; see `docs/CODEX-JITO-V2-remount-inventory-20261028.md`.
- Terminal cancelled, expired or finalized file inspection/export remains a separate read-only follow-up. No terminal state is proof that an unregistered signature did or did not land.
- This is not a deployment or approval to use a real wallet. No hosted migration, provider change, real signing, send or funded transaction was performed.
