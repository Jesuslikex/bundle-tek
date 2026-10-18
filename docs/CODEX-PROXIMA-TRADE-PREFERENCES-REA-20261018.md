# Trade preferences and account navigation evidence

18 October 2026. Read-only REA comparison while the corrected Bundle regression suite holds canonical source at `fd4e571`. No preference value, binding, account setting, provider, credential or wallet action was changed. This note is evidence and remaining requirements, not an implemented settings feature.

## Observed screens

- Settings opening: `ev_9c86c54fc22bdd413e331dc38e6e7fbf48fb2f317450841a8d5b66d046aab3a1`.
- General, trade-panel, wallet-trade and keyboard sections: `ev_ab17e99b3b93e90bbc7c384bd7752642e9737dbb5cafd23e3e2e44d12f7ea8ea`. Each settings-navigation action completed and retained its own accessibility snapshot.
- Exit settings navigation: `ev_590abcc832a5658b0d72b50fd3ca901631d09d8bb04628f967e48d377f7fe794`. This opened a settings section, not a trading action.
- Referral route navigation: `ev_3359254ec0bdd07069667fd091c91346f795bcdc09e66faf0bfc941064aecabd`. The initial capture preceded the content load. The subsequent inspection `ev_143845ababb9d6310d349f4dd2f1143b8565484e318d3012a88b88cc5a0d6017` shows a settled Referral heading and controls for copying the invitation link, claiming rewards and renaming the code. None was activated; amounts and private invitation identifiers are not reproduced here.
- Restoration to the original account page, with Settings closed: `ev_926a7b97339e84597c705f2b30f0581120e63c1e5feb35e8aef3c8facb357caf`.

The permitted captures exclude scripts, raw network bodies/headers, cookies, storage values and secret exports. They establish visible UI declarations, not their backend behavior. Large vendor chunks were not semantically analyzed during this check. No security-setup, 2FA, login-method or session-detail screen was opened.

## Concrete parity gaps

| Area | Proxima observed interface | Bundle state and required work |
| --- | --- | --- |
| General delivery | A provider-racing preference and a router-related protection feature called Shield, with a management entry | Bundle has separate configured-RPC and Jito delivery paths and explicit delivery notices. Parallel-provider execution and a private router are not established equivalents. Vendor speed/protection claims were not tested. Do not relabel existing submission as Shield or guaranteed protection. |
| Display units | Choice between token quantities and supply percentages | Bundle already exposes exact token amounts, observed balance percentages and saved-supply presets in relevant reviews. A consistent persisted display preference across wallet/token views is not implemented by those individual controls. |
| Position valuation | Preference concerning liquidation-based holdings versus quantity-times-price valuation | Bundle's retained linked accounting and missing-evidence states are separate from a fresh executable exit valuation. A visual toggle cannot establish executable P&L or external cost basis. |
| Trade-panel shortcuts | Configurable quick-entry/immediate-action behavior and separate deployer confirmation preference | Current Bundle review callbacks fill/review amounts and maintain explicit consent/signing/submission boundaries. Preserve those user-required safeguards. A future shortcut may prefill a reviewed amount; it must not silently disable approval or mutate an approved packet. |
| Wallet amount presets | Separate buy/sell shortcut values, add/remove/reset controls, unit/currency controls | Bundle has fixed sell presets, including exact unfrozen-balance and saved-supply amounts. Custom reusable buy/sell preset configuration and consistent per-currency presentation remain open. The four values seen in this account are a configured sample, not proven factory defaults. |
| Keyboard shortcuts | Configurable bindings associated with buy/sell preset positions, reset controls and enablement | Chart navigation keys already exist in Bundle. Custom trading-preset keybindings are a separate missing feature. They must respect form focus, busy/locked state, current token/wallet context, fresh amount evidence and existing approval resets. No vendor key was pressed or rebound. |
| Group exit preferences | Controls for confirmation, deployer inclusion and consolidation versus independent wallet exits | Bundle's selected-wallet sell, cleanup and group flows are not proof of every cross-wallet exit mode. Consolidation requires explicit inventory/custody/fee/receipt evidence and exact approved transactions; it cannot be inferred from a settings label. Existing consent safeguards stay mandatory. |
| Referrals | Settled invitation/reward controls | The earlier loading-only observation is superseded for UI presence. Bundle already has invitation-code creation/copy, referred-account counts and explicit code attribution through ReferralPanel and /api/referrals. Its route states that Bundle takes no trading fees and has no payout. Vendor-style reward balances/claim/delivery remain separate and unverified; do not call all referrals absent or invent a reward balance. |
| Account settings | Navigation for account, login methods, 2FA and sessions | BundleAccount currently exposes the signed-in identity, conditional Google linking and sign-out. The vendor navigation does not prove its security implementation. Additional account-management parity needs its own implementation and verification; no credential/security setup was touched. |

Source reviewed: `components/imported-sell-presets.tsx`, `components/imported-token-quote.tsx`, `components/imported-trade-wallets.tsx`, `components/imported-pair-trade-wallet-review.tsx`, and `components/bundle-account.tsx`, plus the existing delivery and strategy evidence notes. Existing percentage helpers reject unsupported/stale evidence and set amounts through handlers that clear prior review state. Do not duplicate those helpers with rounded floating-point shortcuts.

After the source freeze ended, the normal signed-in local app's dashboard visibly exposed its existing referral panel. A follow-up source check of `components/referral-panel.tsx`, `components/project-dashboard.tsx` and `app/api/referrals/route.ts` confirmed that partial capability. No referral code was created/applied/copied, and no reward control was activated. This corrects the earlier limited source inventory; it is not a new referral implementation.

## Implementation direction

The current desktop chart/table proposal remains the next integration step after the baseline freeze. Follow it with reusable amount presets and keyboard-assisted review using current amount callbacks, exact units and context invalidation. Confirm the exact protected-file slot with the owner before wiring global preferences into the token shell. Preference storage must contain presentation terms only, not wallet keys, approval authority or executable packets.

Provider racing, router deployment, consolidated exits, executable valuations and referral payouts require separate qualified backend contracts and user-approved financial boundaries. They remain real parts of the parity gap rather than being declared complete through navigation or a mock toggle. No signing gate was enabled, no provider configured, and no funded action, push or deployment occurred.
