# Codex holder launch UI notice

14 October 2026, before UI edits. Claude is out of credits and the user authorized Codex to continue UI implementation. Main is `b5edfdd`.

Planned scope: new complete holder review panel and its client model/tests; `components/launch/pump-launch-review.tsx` dispatch only; `components/launch/launch-metadata-review.tsx` saved-document prop type only; `app/page.tsx` one saved-document data prop only. Existing create/developer layouts and workspace layout are retained. No protected holder/supply/performance file or global CSS change is planned.

The panel uses the existing owned create preflight for exact supply/quote target sizing, then the existing complete-holder API for simulation, review, approval, signed packet registration, separately approved submission and read-only recovery. User keys remain in the encrypted browser vault. This work does not authorize any real signing/broadcast, remote SQL, migration, provider change, cron, push or deployment.

Verification will use controlled fixtures, synthetic keys and local browser rendering. After verification, Codex will commit locally, fast-forward main and record the result for Claude. The two unrelated dirty main files remain preserved.
