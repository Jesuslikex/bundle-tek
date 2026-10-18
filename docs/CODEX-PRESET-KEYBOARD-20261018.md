# Saved preset keys, 18 October 2026

## Behavior and comparison scope

The current reference requirement is the visible configurable preset-position bindings and enable/reset controls retained in `CODEX-PROXIMA-TRADE-PREFERENCES-REA-20261018.md`. Those captures establish vendor UI, not its backend or financial execution semantics. This checkpoint adds actual configurable persisted bindings to Bundle's existing buy SOL, sell balance percentage and sell saved-supply percentage presets. It does not declare full Proxima parity or implement immediate trading.

The existing account editor now has a collapsed Customize preset keys section. Eight positions per list accept one lowercase ASCII letter or digit; blank disables a position. Nonempty keys must be unique across all three lists. Defaults are Bundle's own explicit position mapping, not claimed vendor defaults. Existing add/remove amounts determine which positions are active. Saving and resetting use the existing authenticated owner, expected-actor and compare-and-swap revision rules. A v2 presentation document stores only amount values and key maps; it stores no enabled permission, wallet key, packet or execution authority.

Each buy/sell panel starts disarmed. Enable preset keys focuses its native toggle control. Only keys typed while that control itself is focused can fill an amount. Moving focus, Escape, window blur, visibility changes, account/token/preference/evidence context changes or a busy/locked state disarm it. Typing in fields, held/repeated keys, composition and modified browser shortcuts are ignored. Handled keys do not propagate to unrelated outer key handlers. Saved mappings survive reload, but activation does not.

Buy keys use the existing amount callback, clearing prior quote/preparation state. Sell clicks and keys share the exact same action object and revalidate current evidence and floor atomic-unit arithmetic at invocation. Disabled/expired/unsupported/uncovered selections remain unavailable. No key quotes, prepares, signs, submits or unlocks a wallet.

## Storage and ownership

Migration 0112 replaces only the preference document admission triggers to accept exact legacy v1 or extended v2 documents. It preserves the owner/revision/timestamp guards, bounded amount arrays and retained delete protection from 0111. SQL independently validates the key-map shape, lengths, character vocabulary and uniqueness. Existing v1 rows remain byte-for-byte unchanged until explicitly saved. Historical migration 0111 was not edited.

Owned source: the trade-amount preference model and tests, preset editor and mounted tests, new `trade-preset-keyboard` component, buy/sell integration, API regression tests, append-only 0112/journal, local HTTPS guard and tests, and a migration continuity test. The other chat's launch-layer coverage API, model, UI, styles and tests remain separately owned and unstaged by this checkpoint. No protected token shell/chart/global stylesheet was edited.

## Verification and limits

- Final scoped run `work/release-qa/preset-keys-final-02`: 9 files / 40 tests pass, with no React act warning. Includes actual preference API/service/disposable libSQL, persistent key maps, account isolation, initial/reload disarming, focus/typing/modifier/repeat/composition/background/lock/token-context refusals, handled-key propagation, stale balance refusal and refreshed-report recovery. Existing quote-clearing/cancellation and exact balance/supply cases remain covered.
- Native guard run `work/release-qa/preset-keys-guard-final-01`: 5 tests pass. The loopback edge admits bounded v2 presentation settings and still refuses executable, secret, malformed and unrelated financial writes.
- Standalone TypeScript exits 0; typed lint passes for the 10 owned TS/TSX files; all 13 supported owned source files are formatted. Final `git diff --check` and the shared production build are recorded below when complete.
- Real Wrangler whole-file application passes all 113 migrations, terminal session 25471, receipt `C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-Scfc8X/report.json`. The first version failed with incomplete input at 0112 in receipt `bundle-wrangler-migrations-xd6bmw`; its nested CASE size expression was replaced by an equivalent boolean arithmetic expression. Local libSQL had admitted both, which is why whole-file Wrangler remains a separate gate. No historical migration or provider was changed to make this pass.
- The migration continuity test inserts a real v1 record under 0111 before applying 0112, compares all persisted bytes afterward, then upgrades through the actual service and verifies stale revision, owner/time mutation and deletion refusal.
- Live isolated browser fixture 4316 uses actual controls and the actual owned preference service with synthetic Alice/Bob sessions and disposable SQL. Quote/provider/vault/transaction endpoints are blocked. Native key 9 fills saved 0.025 SOL; typing 9 in the amount input produces ordinary 0.039 text and disables keys. Native Q fills exact 33.33% balance as 0.001 token; A fills 0.01% saved supply as 0.0001 token. Escape disarms and reload starts disarmed. These are component/service observations, not a funded or hosted session claim.

Migration 0112 has not been applied remotely. No funding, transaction, vault unlock, signing, submission, provider/credential change, push or deploy occurred. The broad Proxima objective remains active; keyboard-assisted amount entry does not establish financial execution, provider racing, every launch adapter, complete market coverage, audited valuation or marketplace settlement parity.

Migration 0112 SHA-256: `790c13d62a650eef5b3c28f0bd566cd3157d3a4e63b80d202e760c29669f2502`. The unchanged 0111 hash remains `edc4d502cea90670359f67e8c5b5ac8328a2a76091b638b18a2891d29bead8e5`. Initial responsive checks fit at 320, 375 and 1440 pixels, including expanded key configuration. The fixture initially used the previous compiled CSS; final rendering must load the new shared build's styles before its final screenshots are accepted.

## Final build and browser acceptance

The build owner reported shared build 40268 terminal exit 0: webpack 30.9 seconds, TypeScript 12.9 seconds, 6 pages in 1208 ms and traces completed. Both source owners held their application/test files throughout and released only after terminal. The peer removed its three temporary public fixture assets before the build. Root's 15 staged paths contained no peer changes, credentials or runtime artifacts.

After terminal, root stopped only its own fixture 83333 and restarted it as 64955, loading all CSS files from the newly compiled build. Final expanded key editor measurements: 320px viewport / 305px document with actual two-column tracks of 111.5px each; 375 / 360 and 1440 / 1425 also fit. The fixture's ordinary vertical scrollbar explains the smaller document width. Custom key 9 was saved again and native key input filled 0.025 SOL with the final compiled styles, while customization remained collapsed in the main view.

Final screenshots: `work/release-qa/preset-keys-editor-320-20261018.png` and `work/release-qa/preset-keys-mobile-final-20261018.png`. They are explicitly synthetic fixture evidence. The earlier CSS limitation is closed for these final screenshots. Post-commit historical migration compatibility and the restored HTTPS boundary are recorded below after their checks.
