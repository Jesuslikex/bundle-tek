# Counter pricing UI work notice

Codex will add components/counter-buy-price.tsx and its tests, and insert the pricing controls only inside the already Codex-owned counter-trade-panel.tsx. The controls will explicitly select a recorded Buy proposal and a SOL swap-input limit, call the authenticated pricing API, validate the response against that request, and expire/discard stale previews. No existing session layout or Claude-owned UI file will change. This note precedes UI edits.

No API, migration, provider configuration, signing, transaction or publication change is part of this UI checkpoint. Record the source commit and verification afterward. Counter's mount point in imported-trade-sessions.tsx remains the separate coordination request in CODEX-COUNTER-UI-UPDATE-20261014.md.
