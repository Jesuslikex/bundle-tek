# Approved recovery navigation integrated

25 October 2026, source base `bfc295b`. Julian explicitly approved the exact prepared `CODEX-RECOVERY-PROJECT-NAVIGATION-20261024.patch` during this turn. This supersedes the earlier parent-approval hold in `CODEX-RECOVERY-PROJECT-BRIDGE-20261024.md`.

Only that patch's 13 additions and two deletions were applied to protected `app/page.tsx`. The physical page now mounts the existing recovery-navigation provider around the dashboard/shared-project branch. It supplies the existing saved-project opening function, blocks while saving or initially loading, and merges the exact owned lookup into the library cache. It does not bypass the existing unsaved-draft guard or silently restore an archived project. Current saved project settings remain distinct from the historical launch review.

Verification:

- 156 tests across eight related files pass: owned project codec/route, recovery discovery/service, recovery navigation, dashboard and account recovery route. These exercise real child/API behavior; they are not a full mount of `app/page.tsx`.
- Plain TypeScript and typed parent lint pass. Parent formatting passes after normalizing line endings only. A direct application of the approved unified patch to the original Git source exactly equals the resulting parent after line-ending normalization; there are no extra text changes.
- Source-derived execution of the actual physical parent's callbacks passes all eight saving/loading/unsaved-state combinations. Dirty drafts retain their original plan until an explicit discard action; saving/loading blocks opening and cache mutation. Normalized ASTs of `guardDraft`, `openProject` and `metadataProject` are unchanged. The physical provider contains the actual dashboard and shares branches; the existing dashboard → account performance → account launch activity → recovery discovery mount chain remains present.

Limits: no new signed-in full-page browser run, production build, deployment or funded test. Prior navigation browser fixtures and Opus reviews remain prior evidence, not a new full-page claim. This closes the source wiring/ownership hold, not all runtime or Proxima parity gates.

The separate expiring-share commit is `bfc295b`. Its `0148` is source-only; no application or hosted migration was run. Claude PR57/59/60 files, original AGENTS additions, seven frozen drafts, signing safeguards, providers, credentials and cron remain untouched. No real wallet action or deployment.
