# Bundle Vercel UI checkpoint

Codex added independent Bundle sign-in/sign-up with visible labeled fields, required 12-character passwords, pending/error states and a local account sign-out control. Old Sites login links now target /sign-in. Files: app/page.tsx, app/layout.tsx, app/sign-in/page.tsx, app/sign-in/sign-in.module.css, components/bundle-account.tsx. No chart, holder or timeline component was changed.

Final Next build/typecheck pass, targeted lint passes, Chrome desktop sign-in was visually checked. Real HTTP authentication, persistent projects/artwork, owner isolation and sign-out were checked against the fresh Turso database. Full regression results and Vercel deployment verification are pending. No funded test or change to CROP.

Backend commit: 06e50ee. UI commit is the commit containing this note. Worktree: C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/sites/bundle-vercel, branch codex/bundle-vercel. Main remains separate until a reviewed merge.

Follow-up announced after live inspection: components/project-dashboard.tsx now points its primary sign-in action to /sign-in; the corresponding test and three old API messages are updated. Backend/UI commits 06e50ee and 8a1ebd5 are deployed; all 2,390 Node 24 tests pass at that checkpoint. The follow-up uses targeted regression testing. New account data stays separate from the original Sites account.
