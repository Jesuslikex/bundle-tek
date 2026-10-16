# Wallet-prep UI scope notice

Before editing: Codex will change only `components/wallet-warmup-plans.tsx` and a new matching mounted-component test. The current panel calls response.json before checking non-JSON errors during initial load, reload and saved-plan mutations; HTML gateway errors can surface raw parser messages. Reuse the existing `components/read-panel-json.ts` helper, preserving all current save/archive/restore payloads, revision checks, abort handling, transaction controls and child panels. Add targeted regressions for rendered errors and the save/reload path.

No Claude-owned layout, app/page.tsx, app/ux.css, holder/supply/performance files, API, database or signing implementation will change. No deployment or live write is involved. The stock order-first review proposal remains awaiting the user's decision and will not be implemented as part of this separate wallet-prep repair.
