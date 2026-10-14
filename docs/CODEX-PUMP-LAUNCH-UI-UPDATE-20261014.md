# Pump launch UI handoff

Backend/signing/migration commit: `f15ffa0`.
UI source commit: `573044c`.
Nothing pushed, saved as a hosted version, deployed or broadcast.

## UI scope

- New components/launch/pump-launch-review.tsx and its four component tests.
- Existing metadata review mounts this panel only for a saved PumpFun project. The keyed draft context resets pending consent and state when project, identity or settings change.
- Token Details passes an explicit create-only draft edit (zero initial buys, disable scheduling); the user must save afterward.
- app/page.tsx passes the saved deployer address/revision. No chart, holder, timeline, workspace stylesheet or other Claude UI file changed.

The panel shows the selected tokenized-stock mint, encrypted mint backup/download/restore, fee/rent ceiling, exact prepared coin identity/packet, deployer vault unlock, explicit signing consent and separately unchecked broadcast consent. Pending signed packets can be registered after a lost response without creating new signatures. Status recovery never automatically resends. Changed draft/metadata host, expired review or mismatched keys disables signing. HTML errors become readable errors rather than raw parser text.

## Checks and limits

91 targeted tests across 13 files, actual-source TypeScript, 19-file typed lint and production build passed on unchanged 1,134-file source. All 80 whole-file migrations apply through real Wrangler to disposable local D1. See docs/CODEX-PUMP-LAUNCH-SIGNING-20261014.md for evidence paths and exact scope. The full application suite was not rerun.

Chrome rendered the actual TokenDetailsForm, PumpLaunchReview, ChainLaunchForm and production CSS in a labelled synthetic local fixture. Checked image preview, public-metadata consent, test-only encrypted mint generation/download, TSLAX identity, prepared review fields and foreign-origin signing rejection. The 390x844 embedded phone viewport had document/client width 375/375 with no sideways overflow. Screenshots: work/release-qa/pump-launch-phone-20261014.png and pump-launch-phone-detail-20261014.png. This is an iframe responsive check, not a physical device test.

The HTTP localhost fixture cannot exercise successful production signing because metadata must use HTTPS and match the current origin. Its HTTPS synthetic review therefore correctly stayed disabled; expiry also became visible. The successful approval/sign/register/separate-broadcast path is covered by component and real cryptographic/local-D1 tests, not a successful authenticated browser or funded mainnet run. No real image was published or wallet transaction submitted in QA.

This supports create-only PumpFun coins using eligible exact quote mints. It does not include initial developer/holder buys, launch scheduling, StonkFun execution or external-wallet signing. Funded execution, live authority compatibility and the existing hosting/CROP migration blockers remain unresolved. Do not describe this as deployed or proven full bundler parity.

The two pre-existing whitespace-only edits in docs/CODEX-JITO-ATOMIC-BUNDLES.md and drizzle/0068_remarkable_frightful_four.sql remain unstaged and excluded.
