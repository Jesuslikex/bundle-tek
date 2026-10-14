# Launch metadata UI work notice

14 October 2026. Before editing UI, Codex is taking the metadata review integration described in source checkpoint 6783978.

Planned existing UI edits: `app/page.tsx`, only the TokenDetailsForm props at the existing mount; `components/launch/token-details-form.tsx`, only the metadata review child/props. Add `components/launch/launch-metadata-review.tsx` and focused component tests. Preserve Claude's layout, CSS, dashboard, token workspace, holder and timeline files.

Behavior: require a saved active project with no pending edits/save; display the exact public identity/image and publication warning; explicit unchecked consent and user action; POST the saved project ID/version; validate returned scope/URLs; reset disclosure/consent on context changes; explain ambiguous write failures and permit an explicit idempotent retry. Publishing metadata does not launch a token. No backend/migration edits belong in the UI commit. No push, version save, deployment, hosted SQL, signature or transaction is authorized here.

After verification Codex will commit locally and add an update naming the UI commit, files and checks.
