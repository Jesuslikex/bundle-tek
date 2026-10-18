# Claude token UI integration

18 October 2026. The previously isolated token workspace pass `9f95a1a` is now retained on local main as `353f762`. Claude's branch and untracked feedback note remain unchanged. This closes the missing client-shell layout check for that pass; it does not establish complete Proxima parity, production release or funded trading acceptance.

## Source and behavior review

The three component files and `app/ux.css` had no changes on main since the candidate's base `d2eb292`. The cherry-pick applied cleanly and preserved the concurrent strategy chat's unrelated dirty files. Current `app/page.tsx` was used unchanged; no app-shell, quote/signing, provider, API or migration edit was needed.

A TypeScript AST comparison against current main found identical multisets of all 56 event handlers, 52 disabled/value/checked/required/pressed/expanded bindings, and 17 fetch/effect/selected-market-publication calls across the three components. This supports the diff review that handlers and gate expressions were preserved; it is not whole-program equivalence or financial execution proof.

Two additional scoped CSS rules were tested in the actual client-shell fixture, then appended on main:

- In a selected token's compact desktop workspace, visually hide the redundant page-title row. The H1 remains accessible, while the visible token name and topbar location retain context. Phone and full-page review modes keep the normal heading.
- At constrained desktop widths 1101–1350px, remove the chart pane height cap. Wrapped controls otherwise clip the plot. Normal page scrolling preserves the entire 310px plot and trading column at these widths; wallets may remain below the fold.

Formatting normalized checkout line endings and added one missing newline at an existing CSS rule boundary. The TSX Git contents remain identical to `353f762`. A PostCSS structural comparison verifies all 777 previous top-level CSS nodes, their nested declarations and their order are unchanged; only the two comments and two media rules are appended.

## Browser evidence

The fixture rendered actual current-main `app/page.tsx`, sidebar, topbar, status bar and current libraries/components, substituting only the candidate's three token components and CSS. It loaded the built app styles and generated Geist font classes. All API responses were synthetic fixtures; provider and financial writes were blocked in memory. This proves client-shell layout and controls, not real-session authentication, current provider coverage or a hosted write.

The existing guarded trusted `https://localhost:3443` helper and the user's existing Chrome extension session were reused. No separate QA server, CDP reconnect or protection change occurred. An initial fixture-only Next Link environment error was corrected with an empty build-time environment shim; no project environment file or credential was loaded or changed.

At 1920×900, including the fixture's 26px banner:

| Element | Top | Bottom | Width | Height |
| --- | ---: | ---: | ---: | ---: |
| Chart pane | 262.69 | 822.69 | 1232.45 | 560 |
| Candle plot | 463.19 | 773.19 | 930.77 | 310 |
| Trade quote column | 262.69 | 545.69 | 351.55 | 283 |
| Wallet section | 836.69 | — | 1232.45 | — |

The wallet section previously began at 900.69px in the same shell. The extra compact-title rule moves it up 64px while the plot retains its full height. Toolbar buttons are 30px high. This is the start of wallet controls, not an always-visible full wallet table.

At 1440×900, the plot is 747px wide and ends at 809.19px inside its pane ending at 822.69px. At 1280×900, the original cap clipped the plot by 22.5px; the added scrolling fallback gives the complete plot with no pane clipping. The 1920/1440/1280 document widths match their viewports. At 375px the document client/scroll widths are 360/360, and at 320px they are 305/305. No main-form controls extend horizontally outside the phone viewport; table scrolling stays internal.

Direct interactions checked: opening the token from the actual sidebar, compact/full-page switching, restored H1 in full-page mode, phone navigation open/close, chart drawing disclosure and draw/cancel state, visible market-data disclosures, and the existing Open chart action. No chart drawings were saved into browser storage. A locator timeout during draw cancellation was resolved by inspecting the visible pressed state and retrying the same correct control; no production code change was inferred from that automation timing issue.

Retained ignored local proof: `work/claude-shell-qa/desktop-1920-final.png`, `phone-375-final.png`, `desktop-metrics.json`, `behavior-audit.json` and `css-prefix-audit.json`. The temporary three public assets and empty directory were removed before the shared build. The agent-created tab was closed and its viewport override reset.

## Checks and remaining scope

- Eight focused UI regressions across four files passed both with the exact candidate source overlay on current main and after ordinary main integration. Three-file typed lint and four-file formatting checks pass. Plain TypeScript passes on the combined working source.
- Final combined production build completed with exit 0 on the frozen token CSS and strategy-check source: webpack compilation 50 seconds, build TypeScript 53 seconds, six static pages and traces complete. The strategy owner restored the normal guarded trusted local HTTPS helper afterwards. No new migration was introduced by this layout integration, so the unchanged 111-file local migration chain was not needlessly rerun.
- Post-build HTTPS checks using system certificate trust: sign-in returns 200 and an anonymous imported-market API read returns 401 with `cache-control:no-store`. No real account was authenticated or mutated for those checks.
- Existing data, quote, signature, approval and submission gates remain unchanged. No funded proof, live launch, complete holder coverage, audited P&L or marketplace purchase is established by a layout pass.
- A persistent chart-plus-wallet-table desktop workspace, signed-in production acceptance, broader strategy/execution integration and the other incomplete items in the completion matrix remain open. Wallets can still require scrolling, especially on constrained widths.

No push, deploy, hosted SQL, provider/credential change, wallet unlock, signature or transaction occurred in this integration checkpoint.
