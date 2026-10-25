# Prepared recovery-to-project bridge

24 October 2026. Source base cc43e31. This is a reviewed source preparation, not enabled workspace navigation, deployment or approval to change the protected parent.

## Prepared behavior

An authenticated GET /api/projects/[id] reads exactly one current saved project by original ID plus authenticated owner, including records older than the library's100-item window. Other owners and absent IDs are indistinguishable404responses. Query filters, malformed IDs, corrupt/oversized data and unsupported timestamps refuse. No provider, mutation, preparation or migration imports; cache-control no-store. Archived projects can be read but the shortcut refuses to open or restore them.

The new manual button is hidden outside RecoveryProjectNavigationProvider. When explicitly wired, it loads current saved settings only; it does not select the original launch review, renew consent or authorize a wallet action. Original record/mint references remain visible and copyable on errors. A provider-wide latest-controller claim prevents two buttons opening out of order; stable methods read the latest callback/blocked state. Button generation, cancellation, unmount and15-second header/body deadline suppress late responses even when transport ignores abort. No automatic reads or retries.

The parent integration is prepared only in docs/patches/CODEX-RECOVERY-PROJECT-NAVIGATION-20261024.patch. It wraps the existing isLibrary branch, blocks while saveBusy or initial library loading, merges the freshly read active project into the in-memory list so older projects can reach the existing metadata guard, then invokes unchanged openProject(project). That function still uses unchanged guardDraft and increments the existing revision. The merge is readonly server data and may remain in the library if the user declines the draft prompt; no draft is discarded automatically.

Patch SHA256: `bfdcce1b029391e476575c7254a225429c89adfb70f5c37c25769046718c65aa`. Original protected app/page.tsx Git blob: `59d6cacf0ca5034b4745490afa8d47141d9fb51b`. The patch is not applied. git apply --check passes.

## Verification

Pinned Node24.19.0:148tests across8files pass. Included66new codec/route cases and25navigation cases plus discovery/account integration. The backend tests use actual committed0005 workspace table/index DDL in disposable Turso, covering owner switching, archived/missing/older-than100, cancellation and size/error refusal. They do not exercise financial triggers or hosted data. Client admission reuses the project library's canonical document parser with exact outer/project identities and transport caps.

Plain TypeScript and scoped typed lint/format pass. A broader read-only formatting check also reported two existing projects/shares route files; those unrelated files were left untouched. All ten owned source/note paths pass the explicit format check. A compiler-host virtual overlay typechecks the proposed parent without writing it. Normalized AST checks confirm guardDraft, openProject and metadataProject are unchanged. Proposed parent copy formatting passes. This does not prove the full actual page runtime integration, because the patch remains unapplied.

Actual Chrome synthetic desktop/375px component harness: no mount read; explicit discovery GET then project GET; original reference preserved; fixture unsaved-draft guard keeps current project unchanged until an explicit decision, Keep editing leaves it unchanged, archived/missing refuse, and wrapping/targets checked. All responses are fixtures and the guard is a fixture; real parent guard preservation is source/compiler evidence, not a signed-in browser run. No financial controls or requests were used.

Two actual claude-opus-5-5 Read/Glob/Grep reviews completed against unchanged12-copy sets, zero permission denials. Initial review requested proof ofmount and blocking initial library load. Root verified the actual chain (ProjectDashboard -> AccountPerformancePanel -> AccountLaunchActivityPanel -> discovery), added the loading condition to the proposed patch, and supplied that context. Follow-up found no concrete critical/blocking issue. Neither review ran tests/browser or granted ownership approval.

## Required next step

AGENTS.md says protected shell/layout files need an approved exact patch. Obtain explicit owner/user approval for the patch above before applying it to app/page.tsx. Then recheck the actual parent/PR state, apply only the approved patch, run actual page integration checks and publish a separate commit. Do not infer approval from the source review or broad parity goal.

Until then the lookup and UI foundation can be reviewed on Git, but the live workspace has no new shortcut. Current settings can differ from the historic launch review; a changed venue, missing or archived project still needs deliberate historical inspection through existing owned GET?id readers. No duplicate generic review writer/reader was introduced. Full Proxima parity and live Jito qualification remain open.

No protected parent/PR57source edit, schema, hosted SQL, provider/credentials/cron, real wallet unlock/sign/send, strategy/funded test or deployment. Original four AGENTS additions and seven frozen warmup drafts are excluded.
