# Owned finalized settlement replay for warmup sequences

21 October2026. Internal adapter followingecbf38e. No API/UI caller or automatic Start is enabled.

## Evidence and ownership

Existing warmup receipt rows retain verification summaries rather than the complete raw provider response. This adapter does not pretend those summaries can independently replay a signature. It re-observes the finalized transaction through the existing configured mainnet reader and existing receipt decoders, checks the wallet signature and saved unsigned packet again, and compares every stable receipt field against the owned retained record. Provider-reported network/finality and balance metadata remain provider evidence; this is not an independent consensus proof.

The SELECT-only query joins the receipt, original preparation and finalized signing intent through the same owner. An owned plan must still exist. Exact plan/captured revision/cycle/wallet revision, stored wallet column, side, mints, input/minimum amounts, approval identity/signature/hash and packet bytes must agree. Legacy rows without a matching finalized app intent refuse this adapter rather than receiving an automatic fallback. No authentication wrapper exists yet: a future server caller must supply its verified session owner, never a caller-selected body owner.

The approval's historical unsigned packet is parsed without applying today's expiry to an already finalized outcome. Its hash/size must equal the saved preparation; no signing or blockhash validity is renewed. Current plan revision/archival is deliberately not an execution prerequisite for historical recovery. The adapter therefore remains useful after archival while granting no new execution rights.

## Buy and sell replay

A buy replays mainnet genesis plus finalized getTransaction through the original Ed25519/packet/native/token balance decoder, then exactly matches the stable stored receipt fields. A sell also loads and replays its exact owned original buy, checks its signature/packet/summary, original cycle/mint/wallet/revisions and captured remaining units/decimals, then uses the original linked-sell observer. That observer retains the buy-before-sell slot, token-program/decimals, exact input, minimum output and provenance checks. Consumed units must match both the recorded sell column and the reviewed source; future-buy and saved-buy action IDs remain distinct.

All receipt/preparation/intent rows and current remaining-unit counters are read again after provider work and compared exactly. Changed/missing parents, ownership loss, malformed bytes, failed/wrong-network receipts, cancellation or provider throttling produce no partial settlement and no retry. Fresh source/observedAt/human limitation text is excluded only from the stable receipt comparison; the actual stored parent text remains part of the before/after fingerprint. No stored record is overwritten or newly inserted.

The returned event contains only the exact sequencer settlement fields, a source fingerprint and false execution/signing/automatic-execution flags. The stated scope is owned signature, packet and finalized balance replay. It does not requalify every original route/program, code identity, wallet custody or current spendability, and is not permission to sign or send. Those checks plus durable authorization remain mandatory for future execution.

## Verification

Final **202 tests across12related files pass**, including23 new adapter cases. The broader cohort includes the actual local session-review/retention routes and immutable storage, sequencer, receipt decoder and context/UI regressions. Whole-project plain TypeScript, three-file typed lint and formatting pass.

The new adapter tests use disposable in-memory libSQL with the real Turso adapter and matching column/join shapes, not application or hosted data. The public fixture uses deterministic synthetic Ed25519 keys to sign transfer envelopes, paired with controlled token/native balance metadata. These are parser fixtures, not real DEX instructions, real swaps or funded proof; the synthetic key is cleared after fixture construction. They exercise the real unsigned-packet and finalized-receipt decoders with a transport double returning genesis/transaction responses, never a real provider.

Successful buy replay performs two SELECTs and two read-only RPC methods. Sell replay performs four SELECTs and four read-only methods for both original transactions. Tests cover the real parser-to-sequencer buy/sell composition, saved-buy source identity, same-owner joins across all parents, missing/unfinalized intent, changed action/revision/amount/packet/summary, wrong genesis, failed/altered signature evidence, parent/counter drift, cancellation and429 with one attempt. Archival/newer current revisions preserve old receipt recovery, with every capability false. Test-only mutations deliberately exercise races; the production adapter writes nothing.

No production source imports the new adapter. No new build, browser, authenticated live provider, complete signing-admission or funded verification is claimed for this unmounted server helper. Opus5.5 review is requested against the committed checkpoint; its results are not implied by this verification.

## Still open

Durable session approval/action identity and budgets, fresh per-action authorization, a browser scheduler using those grants, atomic/crash recovery and explicit user review remain incomplete. The internal sequencer's short source-review deadline is unchanged. Automatic warmup Start and signing stay off. No existing signer/receipt decoder/route, protected layout, schema/migration, provider/credential/cron configuration, application/hosted SQL, deployment or real wallet action changed. Broad Proxima parity remains unproven.

## Accepted Opus5.5 recovery and coverage findings

Claude reviewed pushed0ec90c7 on visibly selected Opus5.5 in a separate read-only checkout. It reported one medium false-refusal case: an already finalized sell can explicitly reference an older buy through its retained historicalBuy link, but the adapter initially compared that buy's revisions against the sell's newer capture. It also identified missing sell-specific mismatch tests. Codex independently checked the actual link helper and original signing route before applying the fix.

Historical replay now requires source kind saved-buy and the exact same complete buyReceipt link in the original preparation and retained signing approval. The historical plan/wallet revisions must be safe positive integers, cannot be newer than the sell capture, and at least one must be older. Only the linked buy uses these exact revisions; its receipt and preparation columns must both match them. The root sell's capture, owner, plan ID, cycle, wallet and mint bindings remain unchanged. Session-buy historical substitution, missing/incorrect/future annotations and mismatched approval/preparation links refuse. The original linked receipt observer still performs its provenance, slot, program and decimals checks.

This expands only read-only replay of explicit historical finalized sells. The v1 automatic review builder still rejects excluded/older-revision receipt history before action generation. Its current-revision guard, the sequencer and all signing/execution flags are unchanged; an old lot is not newly eligible for automatic execution. Old records without the exact retained approval link can continue using their existing manual recovery path, which this checkpoint does not edit.

Final **215 tests/12related files pass**, including36 current adapter cases. Thirteen new cases add historical success, six missing/wrong/future/session-source refusals, five sell-column/source/document/link mismatches and approval-link equality refusal. The synthetic fixture now includes the signing route's actual retained buyReceipt copy. Whole-project plain TypeScript, three-file typed lint and formatting pass. No new build/browser/live-provider or funded proof is claimed.

Claude read the original adapter, all23 original test bodies, fixture, report and AGENTS diff, and parts of the sell observer/link helper and saved-buy builder section. It reported running23/23 original adapter tests successfully in a separate worktree; it did not run the cohort, TypeScript or lint, and did not read every original receipt/packet decoder internal. Its reported test pass is separate from Codex's local verification. A focused review of this committed follow-up is requested; no final review of the new diff is implied here.
