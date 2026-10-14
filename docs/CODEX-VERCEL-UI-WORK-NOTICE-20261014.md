# Vercel authentication UI work notice

Codex is changing app/chatgpt-auth.ts to verified Better Auth sessions, adding sign-in/sign-up UI and auth endpoints, and replacing the old Sites login links in app/page.tsx. The application keeps its owner-scoped APIs, browser-encrypted wallet vault and separate transaction approvals. Authentication will use the established Better Auth library; no caller-supplied Sites header will confer identity on Vercel. The chart, holders and timeline layout will not be redesigned in this migration.

Additional announced UI scope: app/layout.tsx, components/bundle-account.tsx and app/sign-in/sign-in.module.css provide account sign-out and accessible input styling.
