# Counter preview UI work notice

Codex will add components/counter-buy-simulation.tsx and its tests, plus a small mount in Codex-owned components/counter-buy-price.tsx. A pure client response validator may be added under lib/. This follows the existing Counter UI ownership split. No app/page.tsx, imported-token layout, chart, holder, supply, timeline or performance files will be edited. No existing CSS rules will be rewritten.

The UI will request wallet metadata only on explicit action, offer eligible verified Solana wallets, require explicit input/fee-rent limits and request the new read-only Counter preview. It will discard changed-context/stale/expired responses and show the source/code/approval limitations. No signer, vault unlock, submission or automatic provider loop will be added. A follow-up note will identify the UI commit and validation scope. No push or deploy.
