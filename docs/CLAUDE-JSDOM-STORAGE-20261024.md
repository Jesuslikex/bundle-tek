# jsdom `localStorage`/`sessionStorage` restored on Node 26

24 October 2026. Test infrastructure only — no application behaviour, schema,
provider or signing change.

## Symptom

Four Auto Sell component suites could not run at all: every test failed in
`beforeEach` at `localStorage.setItem`, before a component rendered. The cause was
not Auto Sell. Twelve storage-touching jsdom suites were failing — 146 tests — and
the failure was a single environment defect.

## Root cause

Two independent Node 26 behaviours collided with a vitest implementation detail:

1. Node defines `localStorage` as an **own accessor property on `globalThis`** that
   returns `undefined` unless the process runs with `--localstorage-file`. It also
   defines its own working in-memory `sessionStorage`.
2. Vitest's jsdom environment copies a jsdom global only when the key is **not
   already present** (`getWindowKeys` in `populateGlobal` skips keys already
   `in global`), and it sets `globalThis.window = globalThis`.

So Node's `localStorage` won, jsdom never installed one, and `window.localStorage`
was `undefined` too. Every `localStorage.*` call threw a `TypeError`.

`sessionStorage` was a subtler version of the same collision: it *worked*, but it was
Node's implementation, a different class from the `Storage` the suite exposes. Suites
simulating a storage failure with `vi.spyOn(Storage.prototype, 'setItem')` therefore
spied on a prototype that nothing used — five tests were asserting a failure their
spy never caused.

This defect also **masked a real regression**. `components/warmup-cycle-workflow.test.tsx`
asserted on the first `output[aria-live=polite]` in the document. The readiness panel
added earlier today mounts above the history panel and has its own polite live region,
so that positional query silently started reading the wrong element. The storage
defect meant the whole file failed before reaching the assertion, hiding it.

## Fix

`test/jsdom-localstorage.ts`, added to `setupFiles` in `vitest.config.mjs`:

- Recovers jsdom's **real** window through the `defaultView` getter on
  `Document.prototype`. Vitest rewrites `document.defaultView` on the document
  *instance* to point at the global, leaving the prototype getter intact.
- Installs that window's own `localStorage` and `sessionStorage` onto `globalThis`
  and `window`. The properties are `configurable` and `writable` so
  `vi.stubGlobal('localStorage', …)` and unstubbing keep working.
- Only accepts a recovered storage whose `Storage` class is the same one exposed as
  the `Storage` global — otherwise a suite's `Storage.prototype` spy would silently
  miss, which is exactly the bug being fixed.
- Falls back to a small in-memory `Storage` only if jsdom's own storage cannot be
  recovered **and** the existing value is unusable. That keeps the normal path free
  of Node's experimental warning and means a future non-jsdom DOM environment with a
  working `localStorage` is never replaced.
- Does nothing when `window` is undefined, so node-environment suites are unaffected.

Installing jsdom's own storage rather than a hand-rolled shim is the point: it keeps
real `Storage` semantics, keeps `localStorage instanceof Storage` true, and keeps
`Storage.prototype` spies intercepting. A shim satisfies the first two but silently
breaks the third — which is how I first "fixed" it and left 12 tests failing.

Rejected alternatives: `--localstorage-file` gives Node a file-backed store shared
across workers (cross-file pollution); a custom vitest environment would have to
reimplement `populateGlobal`.

## Regression guard

`test/jsdom-localstorage.test.ts` (4 cases) asserts the behaviours the suites depend
on: a working `Storage` instance, `sessionStorage` sharing that class, spies on
`Storage.prototype` intercepting **both** storages, and storage starting empty.

## Validation

- Before: 146 failures across 12 storage-touching jsdom suites (57 Auto Sell + 89 in
  eight others).
- After: **130/130 jsdom test files, 1539/1539 tests pass**, with zero
  `ExperimentalWarning` noise. That is the complete jsdom population, so it is the
  whole blast radius of the change.
- Node-environment suites unaffected: 495 tests across 36 files
  (`lib/auto-sell`, `components/auto-sell`, `warmup-swap-quote`, `unsigned-swap-order`).
- `oxlint` and `oxfmt --check` clean on all changed files.
- `tsc --noEmit`: zero errors in any changed file. The only remaining errors are in
  Codex's **untracked in-flight** Jito files (`lib/jito-qualification-transport.test.ts`
  and `lib/jito-readonly-qualification.ts`), which this change does not touch.

## Limits

- The recovery depends on the current vitest behaviour of rewriting
  `document.defaultView` on the instance while leaving `Document.prototype` intact. If
  that changes, the fix degrades to the in-memory fallback rather than failing, but the
  `Storage.prototype` spy half would regress — which is why it is guarded by a test.
- One test was edited: `components/warmup-cycle-workflow.test.tsx` now scopes its live
  region query to the wallet-history `<details>` panel. The assertion itself was not
  weakened; only the positional lookup that the readiness panel had made ambiguous.
- Not run: the entire non-jsdom suite (thousands of node tests). The guard makes the
  change inert outside a DOM environment, and a representative 495-test node sample was
  run instead.
- No deployment, hosted SQL, provider or credential change, and no wallet action.
  Codex's untracked Jito work and its `AGENTS.md` claim were left untouched.
