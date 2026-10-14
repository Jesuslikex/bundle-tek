# Hosting identity mismatch repaired locally

14 October 2026. The current Sites connection confirms owner access to **CROP · Agent World Testnet**, project `appgprj_6ab6edb6b85c8191a8a67d6d5ce20684`, at https://crop-agent-world-testnet.chris-toney0702.chatgpt.site/ . Latest saved version remains 116. No account switch or access to the friend's account is needed for this target.

The supported source helper authenticated with a fresh CROP-scoped short-lived credential, inspected/fetched the remote and reopened the existing CROP checkout successfully. It retained local candidate `16d7c7d0ef512484f400541870eebb9d408a0ddd`. The credential was passed through hidden stdin, not persisted. Automatic publication was not enabled. No source was pushed, version saved, SQL executed on hosting or deployment requested.

## Development versus release checkout

- Main development source: `C:/Users/Julian/Desktop/Bundle`. Its `.openai/hosting.json` now contains only the existing DB/R2 declarations, with the friend's stale project ID removed. It is intentionally unbound for local development. **Do not register another site because the ID is absent.**
- Main's old `sites` remote was renamed to `pulseforge-legacy`, its push URL disabled, and the main branch's old upstream removed. The old fetch URL remains only as a reference. These are local Git settings, not changes to either hosted site.
- Owned release source: `C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/sites/bundle-tek-crop-hosting`. Its manifest still identifies CROP and its credential-free `sites` remote now points to the CROP repository returned by Sites. Use fresh connector credentials through the supported source workflow; plain terminal pushes may still ask for credentials after the short-lived token expires.

Do not simply assign CROP's ID to main or push main into CROP: main has a different migration sequence, whereas the release copy preserves CROP's seven legacy migrations and existing mapped history. Refresh the candidate from committed main with the established append-only mapping before future publication. The candidate still predates the new Pump launch work.

## What this does not repair

The original friend-owned PulseForge URL and its database were not transferred or modified. This repair routes future release work through the already selected accessible CROP project. User/project data is not copied between accounts.

CROP's unresolved partially applied hosted migration state remains a separate deployment blocker. This turn does not establish the failing hosted SQL statement or ledger. Preserve historical SQL and obtain the documented diagnostics before attempting recovery or publication. New Pump image/signing work is local only.

Verification: the production build passes with the unbound development manifest (work/release-qa/hosting-unlink-build-20261014.log). The CROP checkout remains clean after source opening and remote setup. Main's DB/R2 declarations are unchanged, its stale branch upstream is absent, and the old push URL is disabled. No application code changed; the two pre-existing unrelated whitespace edits remain excluded.
