# Jito external-wallet registration ordering

The Jito signing panel previously registered a wallet-returned packet from the retention callback before the external signer completed its final account and feature checks. It now retains the exact verified packet first, and registers it only after the signer returns successfully and the panel rechecks its context. If the final check fails, the retained packet remains available for explicit recovery; no automatic registration or broadcast follows.

Native withdrawal signing now also detects in-place replacement of the captured signing function before and after the wallet prompt while retaining the existing feature-object identity check. Warmup swap signing rejects a nonempty account list that no longer contains the approved account; the existing empty-list fallback remains for wallets that temporarily expose no accounts.

Synthetic deferred-wallet cases exercise swap and tip success, changed feature wrappers, in-place function changes, account replacement, a different account, the empty-list fallback, and an in-place change during the pre-sign fence. These tests use no real wallet, signing, broadcast or funded transactions. The separate native withdrawal panel also has a registration-ordering concern and remains outside this change.

Independent Node 24 verification passed 153 tests across 13 Jito and signer files. The implementing agent also ran TypeScript, scoped formatting and scoped lint; the lint run suppresses the pre-existing `typescript/no-explicit-any` violations in the shared warmup signer. An independent source review found no blocking issue in this bounded change.

Recovery here is still memory-only: a full panel unmount, reload, tab closure or crash can lose an unresolved wallet response. The owner-scoped read does not make account or server state atomic across devices. Provider qualification and funded end-to-end proof remain open; no provider settings or deployment were changed.
