# Tracker bulk import UI notice

18 October. The user approved independent work while away and the full Proxima-parity goal remains active. REA ev_abf462e174dca2392df4e66bcdae1a6eb3f5f41f132df2ffda94cbdee622a8a3 establishes the vendor bulk form's newline/comma/JSON public-watchlist controls. No vendor import was submitted. Bundle currently splits only newlines and immediately submits the add request.

Planned owned changes: new lib/tracker-bulk-import.ts and tests, components/wallet-tracker.tsx and new mounted tracker import tests, plus notes. Add bounded newline/comma/JSON public metadata parsing, existing/archived duplicate and capacity preview, and explicit Preview then Save. Keep current API validation/atomic add behavior, all existing history:/holdings: keys and chain-read/signing boundaries. No app/page.tsx, shared CSS, vault, protected token/holder/performance file or shared build/server edit.

Review current progress confirmed no overlap and no edits to this scope after e36562f. No funded trade, provider/credential setting, push or deployment. Generic JSON compatibility will be declared exactly; vendor-specific Axiom/GMGN/BullX/RayBot exports will not be claimed without actual format evidence.
