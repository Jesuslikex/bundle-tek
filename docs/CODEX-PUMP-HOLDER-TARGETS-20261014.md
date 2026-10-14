# Owned holder sizing checkpoint

Holder execution sizing now reuses the saved seeded/custom distribution in actual integer base units. It apportions the independently observed total target directly, avoiding a second conversion through rounded percentage previews. Stable slot order and largest-remainder conservation are preserved. Single-wallet and zero-weight slots remain in the manifest with `participates=false`; no addresses are silently discarded or given invented buys.

Sequenced/Organic supply mode derives the exact saved holder percentage from observed supply and rejects a developer-plus-holder target that exhausts the observed initial curve reserve. Quote-budget modes use the separately saved quote amount and its observed/catalog-matched asset identity and precision; they do not interpret the unused percentage as spending or invent a token output. Unscheduled PumpFun projects require one distinct selected holder for every saved slot and an exact deployer.

A read-only owned selection loader joins every holder reference to its active Recipient wallet revision, ownership proof and selected folder revision/membership. It rejects foreign projects, watch-only wallets, wrong roles and archived/changed folders, repeats its project/wallet snapshot checks and returns a SHA256 binding over the project, references, selected state and targets. Callers must compare a fresh binding around simulation/approval; the hash is not permission to trade.

## Verification

Five focused files passed, 29 tests, Node 24: exact integer remainders, saved order, zero-slot preservation, distinct stock quote sizing, precision/schedule/reserve/selection rejection, real local libSQL owner/proof/revision/role/folder guards and existing distribution/funding/wallet/initial-buy preparation regressions. Actual-source TypeScript, scoped lint and production build passed. No UI, migration or provider was changed.

## Still required

This is server-internal sizing and selection, not a holder transaction or funded simulation. Supply-target rows still need explicitly reviewed per-wallet quote caps; quote-input rows need reviewed minimum token outputs. Fee/rent caps, balances, transaction grouping, sequential curve-state simulation, all-wallet reservations, durable approval, signing, submission and receipts must be connected. No live availability, stock issuer backing or funded execution is inferred from a catalog label or this manifest. Signing and execution flags remain false.

No wallet keys were read, signed or exported; tests generated synthetic public identities only. No RPC send, remote SQL, cron, credential change, push or deployment occurred. Claude's files and unrelated dirty main work remain untouched. Production remains source `11ad20b`.
