# Launch metadata UI checkpoint

UI source commit: `37847cd`, 14 October 2026, on main. Nothing pushed, saved as a hosted version or deployed. This integrates backend checkpoint 6783978 and supersedes its statement that no UI invokes the metadata API.

## Files and behavior

- `app/page.tsx`: nine added lines at the existing TokenDetailsForm mount only. Pass the active saved project/version when there are no edits or pending save and persistence is ready; pass the existing save handler. No shell/layout/CSS changes.
- `components/launch/token-details-form.tsx`: new optional props and metadata child below social links. Existing image upload, library and preview remain unchanged.
- `components/launch/launch-metadata-review.tsx` and its test: collapsed review, exact public identity/image, explicit unchecked public-publication consent, owner/project-version request, validated response URI/metadata, ambiguity-aware retry and a bounded 25-second operation including response-body reading. Draft, identity, project or save-state changes remount the review, abort pending observation and clear consent/results. Aborting observation does not retract publication; this is disclosed while pending.
- Pre-edit work notice: `docs/CODEX-LAUNCH-METADATA-UI-NOTICE-20261014.md`.

The review explicitly distinguishes metadata publication from coin/pair creation. External image URLs are not silently downloaded or republished. No automatic publication, signature or transaction occurs. Local HTTP previews cannot create real releases because the backend requires an HTTPS metadata origin. Maintaining the future public hostname remains necessary; this is not decentralized permanent storage.

## Verification

42 tests passed across six files: nine new component tests, existing token-details tests, real-route/local-D1 metadata tests, private artwork tests, launch-plan and quote-catalog tests. Report: `work/release-qa/launch-metadata-ui-20261014.json`. Actual-source TypeScript, four-file typed lint and production build exited zero. The React skill review covered keyed context resets, request cleanup, no background writes/fetches, button/checkbox labelling and result isolation.

All 1,110 source hashes remained unchanged during final checks: `work/release-qa/source-launch-metadata-ui-20261014.json`, digest `b1c94876c6624add727e5bb92dd60b68739d3519e70a005809a8bde33b6bcecf`.

Rendered the actual TokenDetailsForm and production CSS in a labelled synthetic fixture, using the user's existing Chrome browser in a new temporary tab. Verified explicit publication success, link rendering, edit invalidation, save gating and fresh unchecked consent after saving. Desktop viewport was 1920 pixels with document width 1920. Chrome's viewport capability did not change the viewport, so phone coverage used a real 390-by-844 embedded frame instead: document/client width both 375 after its scrollbar, no horizontal overflow. This is responsive iframe coverage, not a physical-device check. Screenshot: `work/release-qa/launch-metadata-phone-20261014.png`. All responses and publication in this browser fixture were synthetic; actual route behavior is covered separately by local-D1 tests. No authenticated browser publication or funded launch was run. The owned preview process and QA tab are closed; viewport override reset.

## Remaining launch work

Venue-specific unsigned create builder and reviewed immutable URI handoff; primary-source/current on-chain StonkFun configuration and stock-token quote admission; Pump quote eligibility; exact funding units; simulation and complete instruction/authority/fee review; explicit signing/submission and receipt recovery; approved funded launch proof. None is established by metadata UI tests. Original hosting/account mismatch and CROP's unresolved hosted migration state remain separate blockers to publication. The new migration from 6783978 was verified only on disposable local D1.

Protected holder/timeline/Claude-owned source, backend/migrations and CROP candidate were unchanged in this UI commit. Only the two pre-existing unrelated whitespace edits remain outside these commits.
