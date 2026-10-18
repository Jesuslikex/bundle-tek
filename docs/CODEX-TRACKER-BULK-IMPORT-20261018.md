# Reviewed public-watchlist imports

## Reference evidence

Fresh REA read-only tracker inspection: ev_75510493dbe5eef4136bfd1c33c343af8c2a7e618bc14b0860e61d7d77391c33 shows the empty tracker and Add Wallet/Bulk Add controls. ev_de46cfdb17ee483c8e7b9201f3012ddfd4b375351c43d7cb26888463538030b5 shows the unsaved single form (public address/name/icon). ev_abf462e174dca2392df4e66bcdae1a6eb3f5f41f132df2ffda94cbdee622a8a3 shows the unsaved bulk form declaring newline/comma/JSON inputs and optional name/icon/bookmark. No vendor input or import was submitted. These are observed interface declarations, not verified vendor parsing or execution semantics. Named Axiom/GMGN/BullX/RayBot compatibility remains unproven.

Private local export: C:/Users/Julian/Desktop/REA/results/proxima-tracker-20261018-evidence.json,16 records,1003925bytes,SHA2560f6c322653d586a64530817e7fb8fabcd13d3924c81dcea75b0445823d81f046. It includes prior UI evidence; zero exporter unknowns does not mean full product coverage. Account data stays outside Git. Browser restored to /account with collapsed sidebar (ev_cf3ae3d4f617206115fcd1ca9d021df345738b513539e635ac883a7e52fe0c1f). Invalid extra locator field was rejected before a scenario; it granted no new action.

## Bundle change

Bulk add previously split only newlines and immediately sent the batch. It now accepts newline/comma public addresses and bounded generic JSON arrays of address strings or objects containing only address, name, icon and bookmark. Imported names/icons/bookmarks map explicitly into existing server fields, with selected network/group and fallback metadata. Existing network/address/checksum/icon/label validation is reused. Unsupported fields, malformed metadata, duplicate batch rows, oversized input/request and over-capacity batches are refused locally with safe row-numbered messages. Raw JSON parser exceptions and untrusted values are not echoed in errors.

Preview shows new rows and metadata, skipped existing/archived counts and the selected network. Existing labels and archived states are never rewritten or restored. Archived entries count toward the existing100 limit. A batch with no new rows explains restoration and cannot save. Loading/unavailable roster blocks preview with a visible Reload tracker instruction. The request is bounded by the existing route's20,000-character limit.

A separate explicit Save follows preview. Any change to text, network, batch metadata or the loaded roster invalidates it. Parser errors appear next to the import action and clear when their input changes. The unchanged authenticated API still independently validates and atomically inserts public records under its original capacity guards. No new endpoint, backend schema, provider read, key import, signature or financial action is introduced.

## Ownership and validation

Review current progress explicitly confirmed no overlap. Reserved vault/onboarding, app/page.tsx, token/holder/performance files, shared CSS and HTTPS/build state are untouched. Existing history:/holdings: key prefixes remain.

Five-file regression run73 tests passed together: tracker-bulk-import, tracked-wallet, wallet-tracker-import, tracked-transaction-panel and actual tracker route/local D1. After the final inline-error/context-clear presentation change, parser+UI24 cases passed, then all five mounted UI cases passed again with the explicit stale-error assertion. Plain TypeScript, four-file typed lint, formatting and diff checks pass. React review verified local derived preview context, explicit form actions, bounded inputs/list keys and no render-time network work. An initial EVM fixture used the wrong lower-case network key and was corrected to the existing Ethereum enum; no validator was relaxed. Windows Cloudflare/DOM type collisions in the new test helpers were corrected before passing TypeScript.

Chrome harness imports the actual component and public production CSS, uses in-memory fixture saves, and refuses every request except its local /api/tracker fixture. Verified invalid-row feedback next to the action, corrected input clearing the error, JSON metadata/archived skips, preview and explicit save returning one labelled/favorited row. At375x812 the settled document clientWidth and scrollWidth both360; the wide table scrolls inside its own container. Initial viewport-transition reading1432 was transient; settled DOM/body measurement and pixels showed360. Temporary viewport was reset. Two development HMR observation timeouts were rechecked on the same tab; no replacement server or shared build was started.

Ignored artifacts: work/tracker-import-qa/desktop-preview.png, mobile-preview.png and saved-fixture.png. This is synthetic browser coverage plus existing real-route tests, not an authenticated production import or live provider proof. No vendor-specific export adapter is claimed. No real wallet/key/password, funds, signing, push, deploy, migration, cron or provider/credential configuration changed.
