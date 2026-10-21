# Warmup read modes, approval and recovery

Source-only follow-up to `297bf1f`. The owned warmup session screen now offers the connected runtime observation API alongside its existing basic quote/simulation preview. This is still a manual read of the first pending action, not an executing Generate Activity session.

## User flow

Choose **Quote and simulation** or **Runtime checks**, then approve that exact read with a separate, initially unchecked checkbox. Changing the mode or withdrawing approval cancels an in-progress local reminder admission. Closing or invalidating the component also prevents a late admission from saving an ID or making a POST.

The selected mode and original head are retained before the one POST. An unfinished request locks its mode. A missing saved ID can only be requested again with separate approval, its same original ID/head and original mode. Mounting, reopening, recovering and finding history never start provider work or renew a deadline.

Results distinguish saved observations, refusal, unknown outcome and expired history. Runtime observation expiry is separate from the original request expiry and cooldown. The next-check time is the later of the shared request expiry and cooldown. Historical, non-current rows do not advertise timing for a new request. Coverage details stay collapsed; all signing/trading and trusted-program authority remains false.

The owned parent now describes the two read modes accurately and keys the child by journal ID. Protected Claude shell, layout and global CSS were not edited. The owned CSS corrects checkbox sizing, keeps labels and buttons usable on phones, and associates disabled controls with their reason.

## API and display admission

- New authenticated GET-only `session-v2-read-history` returns the original mode with a saved record or a bounded history page. It accepts only the original ID, or journal ID and immutable cursor. It never calls a provider or writes a result.
- Listing reuses the original full owned-journal and lease/cursor checks, then admits at most 25 purposes in one metadata batch. Each purpose digest is checked against its original owned lease/head/terms. Legacy attempts without purposes remain previews.
- Basic preview GET/list refuses runtime records with 409 rather than mislabelling them. Its GET does not return the same ID as a misleading recovery hint.
- A normal runtime recovery reuses the already validated attempt, avoiding a duplicate full history walk. The existing read-race condition permits one saved-read retry only.
- Browser admission preserves the original exact action/head/fee/quote checks and adds strict runtime flags, packet identity, at-most-32-slot span, observation timestamps and earlier effective expiry. A response cannot choose a POST's mode or upgrade a preview reminder.
- The new reminder format records mode explicitly. Existing preview reminders and their archived bytes remain readable. Discovery is bound to the current context; stale or late responses cannot become the current marker. Saved reads wait for local reminder admission. Mode mismatch and HTML/storage errors retain the original request rather than starting another one.

## Review and verification

Actual `claude-opus-5-5`, high effort, completed initial and follow-up read-only reviews. Both copies were unchanged and both had zero permission denials. Opus ran no tests. The first review's expiry, stale-discovery, withdrawn-approval, self-hint, replay-cost and accessibility findings were corrected; its follow-up confirmed those corrections with no blocking authority or correctness finding. Final low-severity reminder-load, same-ID hint, historical/refused copy and accessibility corrections were independently implemented and tested after that follow-up, not rereviewed by Opus.

Final results and source hashes are in `CODEX-WARMUP-RUNTIME-UI-EVIDENCE-20261021.json`. The related regression run includes the real new route, native provider/storage/public DTO to browser-parser composition, legacy APIs and signing isolation. Controlled promise gates cover mode changes, approval withdrawal and unmount during admission; late discovery and source invalidation are tested without arbitrary sleeps.

The final frozen run passes **1,844 tests in 95 related files**, with one opt-in real SQL-clock case skipped and no failures or unhandled errors. All 2,787 source hashes are unchanged through that run. The skipped clock case was verified in the server checkpoint; its slow wait was not repeated for this UI/metadata-read change. Plain TypeScript, eleven-file typed lint and twelve-file formatting pass. This is not a full-repository test claim. An earlier 35-test run exposed a test that asserted before asynchronous recovery finished; it now waits for the retained ID rather than a fixed number of event-loop turns. Final new checks include real DTO admission, one normal full runtime replay, and refusal of the old preview route's self-recovery hint.

The final isolated production build also passes on pinned Node 24.19.0: committed base297bf1f plus twelve exact functional overlays, with unchanged source hashes. No local environment file or production credential was copied into that build, and no deploy was run.

Chrome uses the actual owned component/CSS in a standalone synthetic local harness. At 1440, 375 and 320 px it has no horizontal overflow; measured visible buttons are at least 44 px. Final-source approval, passive remount and GET-only recovery preserve one POST; expired observations remain history. A held-read Stop/late-result case was also checked before the final small recovery follow-up. The final screenshots reflect the corrected expiry/result layout. These are not signed-in full-workspace or real-provider checks. QA tabs and servers were closed, viewport overrides reset, and the user's Proxima tabs preserved.

No migration, schema, existing SQL guard, provider, credential or cron setting changed. New history queries read saved metadata only. Migration 0135 and all older files remain immutable. The previous server checkpoint's disposable 136-migration proofs remain prior evidence; unchanged migrations were not applied again here. No application or hosted database was migrated. Commit/push shares source only; Git deployments remain disabled.

## Still open

This does not establish full Proxima parity, automatic activity, funded execution or production readiness. Native saved-buy Sell runtime composition, current read-only provider qualification and reviewed program policy are still needed. Financial reservations, short browser signing authorization, finalized settlement, action/budget advancement, durable session orchestration and qualified alternative routing remain separate work. The runtime order's own minimum remains explicitly distinct from an independent price check. Do not unlock signing or weaken any Clock, custody, minimum-output, code-scan or 32-slot check to bridge these gaps.
