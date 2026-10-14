# Claude UI update: sign-in rough edges

14 October 2026. Display-only fixes after checking https://bundle-tek.vercel.app/. No auth logic, session handling, signed messages or server code changed.

- Visible branding now says "Bundle Tek" everywhere the app shows its name: browser tab title (`app/layout.tsx`), topbar brand, sidebar footnote and the loading message (`app/page.tsx`). Protocol strings that still say PulseForge were left unchanged on purpose: the browser vault encryption label, verified devnet memo prefix and wallet ownership messages. Changing those would break existing vaults and verification.
- The floating account control (`components/bundle-account.tsx`) is hidden on `/sign-in`, which has its own form.
- The sign-in form (`app/sign-in/sign-in-form.tsx`, `sign-in.module.css`) adds "Continue without signing in" back to `/`.

Tests: 2 new regression tests in `components/bundle-account.test.tsx` and `app/sign-in/sign-in-form.test.tsx`. Sign-in, wallet-login, account, auth and dashboard tests pass (5 files), with TypeScript and scoped lint. Not deployed; a new Vercel deployment is needed for these and the earlier Google/Solana sign-in commits to go live.