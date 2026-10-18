# Same-block Volume planning and session tip budgets

18 October 2026. Local checkpoint following the REA Volume form inspection. No funding, transactions, provider changes, deployment or push authorized or performed.

## Delivered

- Volume mode selector adds **Same-block bundles (preview only)** alongside existing scheduled swaps. The new form calculates locally, takes an explicit fixed buy amount and total session tip limit, keeps timing collapsed, selects public workspace wallets and shows a phone-friendly budget review. Invalid settings clear the previous review. Returning to scheduled mode restores its existing controls.
- Independent `volume-bundle-plan-v1` contract models each round as one wallet's ordered Buy then Sell, with sell source restricted to that round's buy output. Fixed buy size, nominal target rounding, seeded between-bundle delays, duration and wallet validation are deterministic. Wave intensity does not apply. The contract contains no packets or execution authority.
- Exact BigInt tip budgeting divides the total cap across planned bundles, retaining division remainder as unallocated. Every per-bundle cap stays within the existing 1,000 to 10,000,000 lamport policy. Caps are maxima, not a directive to spend. Network fee estimates remain separate and state their assumptions; rent, swap losses, eligibility and funding requirements are unknown.
- Pure `volume-tip-budget-v1` reducer reconstructs the plan before checking reservations. One live/finalized attempt per round, unique attempt IDs, bounded history, idempotent exact replays and strict caps prevent double reservation or overspending. Unsigned cancellations may release their caps. Once marked submitted, timeout, expiry or missing receipts cannot release the hold. Final accounting charges at most that round's cap; a finalized round cannot run again. No mutable global ledger or runtime integration.
- Scheduled terms, seeded plan serialization, packet validation, service, API, schema, Jito preparation and submission are unchanged. Strict scheduled request parsing rejects the new plan terms and unknown bundle actions.

## Validation

- Final focused Vitest selection: **6 files, 70 tests passed**: new bundle plan and tip budget, existing Volume plan, batch, API route and panel tests. Includes six pinned legacy scheduled digests, new-format rejection at scheduled parser, deterministic/rounding/duration/wallet validation, cap and replay accounting, uncertain-submission hold, cancellation/replacement, altered plans and UI edit invalidation/mode return. All signing-related pre-existing tests use synthetic keys/packets only.
- Plain TypeScript and seven-file typed lint passed before production build; final post-build standalone TypeScript, seven-file typed lint and eight-file format check passed afterward.
- Codex in-app browser used an isolated Vite fixture mounting the real panel and styles, with a synthetic public wallet, mocked reads and all non-estimate writes refused. No user auth, cookies, vault data, keys or provider calls. Checked 375 x 812 layout, low budget error in SOL, corrected ten-bundle review and return to scheduled mode. No horizontal overflow (document 360px at viewport 375px). Viewport reset, temporary tab closed and fixture server stopped.
- Screenshot: ignored `work/release-qa/volume-bundle-budget-375-20261018.png`. This is synthetic component proof, not an authenticated or live-chain run.
- Combined webpack production build **passed (exit 0)**, including TypeScript and route generation. It includes the other chat's frozen exchange UI/API source; its files are excluded from this commit. Build log: ignored `work/release-qa/volume-bundle-budget-build-20261018.log`. Guarded local HTTPS restarted afterward.
- Restarted local sign-in page returned HTTP 200. A probe at `/api/auth/session` returned 404 (not an application route); no authenticated runtime claim is made.

## Remaining execution work

This is a planning and accounting foundation, not operational same-block execution. `planningOnly` remains true; `signingAllowed` and `executionAllowed` remain false. There is no new save, approve, sign or send endpoint. The existing provider builds sells against settled wallet balances and cannot simply be reused to construct both legs before the buy lands.

Before enabling execution: build both legs together against exact buy-output semantics; bind project/mint/revision, ordered original packets, lifetime and tip payer; independently verify and simulate the complete round; persist owner/session-bound reservations with transactional compare-and-swap before any submission attempt; verify finalized receipts/actual tips before accounting or releasing uncertain holds; add explicit approval, one-attempt transport and recovery. The reducer accepts already-admitted finalized accounting events and does not itself verify blockchain evidence. Never treat client-supplied reducer data as durable authority. No same-block atomicity, landing, spend or profitability claim is established here.

Wallets stayed unfunded. No real wallet unlock, signature, preparation or send was requested. No schema, credentials, provider, cron, remote SQL, push or deploy changes. Preserve the other chat's concurrent exchange funding files.
