# Local Jito recovery-file locator

The new local helper reads a private recovery-file byte snapshot of at most 4 KiB using the existing strict JSON parser. It rejects malformed UTF-8, duplicate decoded keys, excessive nesting, wrong fields, invalid identifiers and packet bounds, proxy-backed or non-byte views, and shared memory. It returns only a frozen project ID, session ID, bundle ID, manifest digest and packet index; it does not return the signed packet, contact a server, verify a signature or authorize an action.

The bounded parser creates its own internal signal and is not caller-cancellable. Callers must recheck the signed-in owner and UI context after awaiting it, fetch the exact owner-scoped record using only the identifiers, and cryptographically verify the same private byte snapshot against that record. Temporary private bytes and strings can remain in JavaScript memory until garbage collection; secure erasure is not claimed. No UI currently invokes this locator.

Independent Node 24 verification passed 39 tests across two files, plus scoped typed lint and formatting. Independent source review found no blocker after input-brand hardening. No live provider, wallet, signing, submission, funded action or deployment was used.
