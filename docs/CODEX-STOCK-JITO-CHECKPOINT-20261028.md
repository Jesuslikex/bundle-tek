# Stock and Jito qualification checkpoint, 28 October 2026

This checkpoint improves bounded, unsigned qualification. It does not qualify stock pairs or Jito for live trading, change signing gates, or authorize execution. No deployment, hosted migration, credential or provider setting changes, wallet signing, broadcast or funded trade occurred.

## Changes

- The stock order-first flow starts one unsigned order request after the initial quote, concurrently with the quote's mandatory post-read checks. An ownership and revision snapshot is checked before dispatch. The order is not used if those checks fail, and cancellation aborts it. The early minimum-output guard remains strict. Provider errors are sanitized; later fresh-reference, custody, Clock, code-scan and 32-slot checks remain in place.
- Jito fee members must use the exact simulation bank and each must remain inside the original 32-slot window. A reproduced mixed-bank case previously admitted one fee outside that window; it now refuses. Raw retained fixture evidence is unchanged.
- The stock and Jito qualification adapters compile in memory and write exactly the produced bytes from Node. This fixes a Windows esbuild subprocess write refusal without granting any signing or execution authority.

## Evidence and limitations

- One live, read-only USDC attempt passed the early minimum-output guard, then refused at the unchanged runtime window: slots 462550550 to 462550592, a span of 42. It recorded one simulation, both 24-read code scans, zero 429s, zero signatures and zero broadcasts. Its quote-to-order-dispatch timing was 0.292 ms. One attempt is not evidence of repeatability; SOL was not tested in this checkpoint. The receipt is retained locally under ignored `work/stock-qualification-2026-10-28T16-51-25-253Z/` and contains provider-related metadata, so it is not published.
- The configured dedicated stock runtime endpoint was absent locally, and the sample used the existing fallback. No endpoint was changed. Whether a different configured provider or further pipeline work can reliably meet the limit remains unproven.
- The Jito fee-window fix is verified offline, including retained-response replay. Full read-only Jito economic and runtime qualification is still open; no new live Jito campaign was run. Exact bank, independent mint/Rent evidence, runtime semantics and repeatability still need evidence.
- Current-source focused verification: 330 Vitest tests across 13 files, 39 Node campaign/timing tests, TypeScript, scoped typed lint and formatting, and stock qualifier syntax pass. This is not a full suite, production build or funded end-to-end proof. The isolated worktree reused installed dependencies from the original checkout, which differ from the current lockfile's Next version.
- A focused Claude Opus 5.5 source review found the provider-error sanitization gap, which was fixed and tested afterward. That review did not cover the final exact source or the subsequent adapter write changes.

Keep stock signing disabled pending qualification, retain every refusal, and do not loosen the minimum-output or 32-slot checks. Future work should diagnose the long runtime stages and establish repeatable SOL and USDC results before proposing signing or a release.
