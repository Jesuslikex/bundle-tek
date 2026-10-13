# Stock quote discovery update for Claude

Verified source commit: **547c5120e99df00554cb67e4f519ce796751473f**. Source file touched: **lib/quote-catalog.ts only**. No file in Claude's UI scope was edited. This follows the boundaries in CLAUDE-UI-WORK-NOTICE-20261013.md.

StonkFun's captured NVDAX, SPYX and TSLAX identities now appear at positions 2, 3 and 4, previously 42, 46 and 48. The existing chain selector renders the first 40 choices, so these are available in its initial choice set without Show more. The first/default asset is preserved. Selection is still by exact mint, not ticker alone. No captured assets were added, removed or relabelled.

A direct before/after source comparison covered all 37 current venue profiles: every default and complete identity set is preserved; every other venue's ordering and all unresolved metadata are unchanged. Evidence: work/release-qa/stock-discovery-order-20261013.json. Existing quote-catalog and launch-plan tests passed **14 tests** with work/** excluded. Actual-source TypeScript, one-file typed lint and production build passed. Logs: work/release-qa/stock-discovery-*-20261013.*. Reviewed file SHA256: 94d79b21b19e06649902a81aba26b652c387a539f9f07a99832b837976bb4ad9.

This is source/data-order verification, not a new rendered browser check, issuer verification, fresh venue admission or funded pair launch. The user requires actual tokenized-stock quote pairing, and CODEX-STOCK-QUOTE-PAIRS.md preserves the full execution requirements. Live issuer/mint-extension/venue checks and launch execution remain unfinished. No Counter, DCA, migration, hosted database, credential, push, version-save, deployment or financial action occurred. The old friend-owned live page remains unchanged.
