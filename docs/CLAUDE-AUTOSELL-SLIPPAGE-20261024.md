# Auto Sell: tighten-only slippage ceiling

24 October 2026. Basis `50a9e30` (Codex Jito fee/simulation bank). Area: Auto Sell
(`lib/auto-sell*`, `components/auto-sell*`) plus the shared quote helper it drives.

## What the app already enforced

Every imported-swap quote was pinned to 50 bps (0.5%) at three points:
`lib/warmup-swap-quote.ts` sent `slippageBps=50`, required the provider to echo
exactly `50`, and required `otherAmountThreshold >= outAmount * 9950 / 10000`.

The downstream checks are already *floors*, not equalities, at 9950 bps
(`lib/jupiter-route-assessment.ts`, `lib/wallet-warmup-session-preparation-view.ts`,
`lib/strategy-unsigned-preview.ts`). A tighter quote therefore already passed every
layer; a looser one was already refused. Only the request constant and the echo
check blocked a user from choosing less slippage.

## What changed

Tighten-only, as *refuse-not-clamp*:

- `MAX_SWAP_SLIPPAGE_BPS = 50` and `swapSlippageBps(value)` exported from
  `lib/warmup-swap-quote.ts`. Absent keeps 50. Non-integer, `<= 0`, `> 50`, `NaN`
  and `Infinity` throw `PARAMETER_MISMATCH` before any provider request.
- `quoteSolanaSwap`/`prepareSolanaSwap` take an optional `slippageBps`. The response
  must echo the *requested* value, and the minimum-output floor is now derived from
  it (`outAmount * (10000 - slippage) / 10000`). A provider that echoes a tight bps
  beside a loose minimum is refused with `OUTPUT_PROTECTION` instead of passing.
- `lib/prepare-owned-imported-swap.ts` accepts an optional `slippageBps` body field
  and answers `400` with the precise reason. The field is omitted from the forwarded
  call when not supplied, so an existing client's request is unchanged.
- `AutoSellSessionRules.maxSlippageBps?: number` with a `1..50` rule in
  `autoSellSessionError`. `AutoSellExecuteDeps.maxSlippageBps` is sent on the
  preparation request only when defined — the request stays byte-identical otherwise.
- `components/auto-sell-modal.tsx`: a labelled `<select>` (0.5% default, 0.25%, 0.1%,
  0.05%) in Session settings, restored by `loadConfiguration`. Because it is part of
  `sessionRules`, it is inside the existing `JSON.stringify` draft comparison, so
  changing it mid-session invalidates an approved edit review automatically.

Refusing rather than clamping is the point: a silent clamp would let an operator
believe a trade was quoted tighter than it actually was.

## Validation scope

- `npx tsc --noEmit --incremental false`: clean.
- `npx oxlint` + `npx oxfmt --check` on all 8 changed files: clean.
- New cases: 4 in `lib/unsigned-swap-order.test.ts` (default 50, 25 bps end-to-end,
  refusal of `51/100/0/-1/1.5/NaN/Infinity` before any request, tight-echo/bad-minimum),
  1 in `lib/auto-sell-session.test.ts`, 2 in `lib/auto-sell-execute.test.ts`.
- `lib/auto-sell` + `components/auto-sell`: 456 tests / 34 files pass.
- Quote, route-assessment, preparation-history, simulation and the whole
  `app/api/imported-projects` route family: 750 tests / 47 files pass.

## Outstanding blocker (pre-existing, not caused here)

Four Auto Sell component suites — `auto-sell-lifecycle`, `auto-sell-pending-lock`,
`auto-sell-outcome-modal`, `auto-sell-review-recovery-modal`, 57 tests — could not run
on `vitest.config.mjs` in this checkout. Node v26.4.0 installs an own-property
`localStorage` global that is `undefined` without `--localstorage-file`, and it
shadows jsdom's, so `window.localStorage` was `undefined` and `beforeEach` threw at
`localStorage.setItem` before any component rendered. `sessionStorage` was unaffected.

That was verified here by running those four suites (plus the full Auto Sell surface)
under a temporary config with a `Storage` shim: 57/57 and 456/456 passed. The defect
turned out to be much wider than Auto Sell — 146 failures across 12 storage-touching
jsdom suites — and is fixed in shared test configuration by the follow-up commit
described in `docs/CLAUDE-JSDOM-STORAGE-20261024.md`. No shim from this change remains.

## Limits

- No deployment, push, hosted SQL, provider/credential/cron change, real wallet
  signing or send, or funded trade. `AGENTS.md` (Codex's uncommitted claim hunk) and
  the untracked Codex Jito/warmup files were left untouched.
- Rendered browser QA of the new select was not performed; the component suites above
  exercise the modal logic but not layout.
- The 50 bps pins in `counter-buy-*`, `imported-trade-pair.ts`,
  `pair-order-quote-bounds.ts`, `counter-owned-preview.ts`,
  `strategy-unsigned-preview.ts` and `counter-buy-price.tsx` are separate features and
  were deliberately left at 50.
