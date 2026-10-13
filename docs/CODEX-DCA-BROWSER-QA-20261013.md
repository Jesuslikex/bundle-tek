# DCA composer browser verification and draft-status repair

13 October 2026. Chrome rendered the actual DCA composer and application globals/UX styles from a clean git archive of 15dc8a2. A local React/Vite harness supplied an explicitly labelled synthetic wallet and supply. Application fetches were intercepted in the fixture page; saves existed only in memory. No authentication, production API, D1, provider, wallet vault or signing flow was exercised. This establishes component rendering and browser interaction, not integrated token-page or funded/hosted proof.

## Observed behavior

- Buy: 0.03 SOL split into three exact 0.01 SOL cycles. Scheduled 12:00 local became 11:00 UTC; a 180-second duration displayed and saved 11:03 UTC. A 120-second duration at the final cycle boundary disabled saving.
- Random Sell: 10% of the fixture's saved total supply produced an exact 100000000000-atom budget, conserved across three cycles within reviewed 20000000000–50000000000-atom bounds. The displayed percentage intent, captured supply/time and exact deadline reached the in-memory saved request.
- At explicit 1440×1000 and 390×844 Chrome viewports, the document width matched the usable client width (1425 and 375 pixels respectively, accounting for vertical scrollbars). The phone check found zero overflowing input/select/button bounds. Screenshots and DOM snapshots are retained; the responsive scope is this standalone composer with production styles.
- Changing a random budget disabled saving and replaced the success message with the existing allocation-regeneration warning.

## Found and repaired

The initial browser run reproduced a stale success notice: after saving Buy DCA, changing the side or amount left “DCA session saved” on the changed draft. The composer now attributes operation messages to the exact draft context, including allocation, wallet/project revisions, side/unit/sizing, schedule/deadline/duration and market bounds. Messages are shown only for their matching context. In-flight locking and saved session data are unchanged; the fix does not alter backend or signing behavior.

The final browser run used the archived base plus only the owned patched composer, whose SHA-256 exactly matched main: 222d0de3d51ad32a8b3a6ff3da975b3bc23a21c3f8bdeafaba28fb7dc39bbd21. It verified saved-status removal after amount and side changes, random supply conservation, allocation invalidation and phone control geometry. The regression test separately covers changed timing. A preliminary browser check incorrectly expected no status element after changing a random budget; the actual element contained the correct allocation warning. The final check tests absence of stale saved text while retaining that useful warning.

## Validation and evidence

Final model/composer regression: **20 tests in two files passed**, zero failures, JSON success=true. Actual-source TypeScript handle 54979, two-file typed lint and production build handle 47725 all exited 0. Frozen source has 1054 files, digest ba451b9c0319dc2365da35db2f38a9973ef415e80b3d2ee4ab23c59c18462449; post-run unchanged=true. Logs/reports: work/release-qa/dca-status-*. The earlier 54 real-route/local-D1 tests in CODEX-DCA-DURATION.md predate this frontend-only notice repair; they were not rerun or presented as a new full-suite result. Backend and migration files did not change.

Browser evidence is retained at C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/work/dca-browser-15dc8a2/evidence: browser-checks-final.json, buy-duration.json, final-sell-random-supply.json, final-phone-dom.txt, final-desktop-dom.txt, draft-status-after-amount.txt, final-desktop.jpg and final-phone-full.jpg. The original browser-checks.json records the preliminary over-strict status-element check and is superseded by browser-checks-final.json. Original pre-repair captures remain for diagnosis. The synthetic allocation varies per explicit generation, so the later desktop image need not match the earlier saved random allocation.

Chrome's temporary viewport override was reset and only the created QA tab was closed. The fixture server was stopped; its files/evidence remain. Claude-owned files, the two pre-existing dirty files, migration history and CROP candidate 6e75c7e were preserved. Nothing pushed, saved as a hosting version, deployed or transacted. Integrated authenticated workspace rendering, monitoring browser coverage, funded workflows, full Proxima strategy parity and hosted migration recovery remain open.
