# Google sign-in

Announced UI scope: app/sign-in/page.tsx becomes a server wrapper and app/sign-in/sign-in-form.tsx owns the client form. Existing sign-in stylesheet adds a Google button above the email alternative. lib/auth.ts configures Better Auth Google only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both present. Existing password login remains available.

Production callback must be https://bundle-tek.vercel.app/api/auth/callback/google. Google requests only basic identity, uses an account selector, and requests online access without incremental scopes. Credentials are server-only. Automatic email-based account linking is disabled so an unverified password account cannot be silently linked. No new schema migration is needed.

Google Cloud credentials and live OAuth approval are pending. Do not claim Google login is live before those are configured and the callback is verified. No other UI components, wallet signing, provider credentials or deployments changed at this checkpoint.

Verification: 7 targeted tests pass across auth, request-origin guard and the sign-in form. They cover Google state/PKCE, exact callback, identity-only scopes, online access, malicious callback rejection, unconfigured-provider rejection, the button request payload and safe errors, plus the existing real libSQL password/session tests. Typecheck and typed lint pass. Production build passed compilation, TypeScript and page generation; its final trace result will be checked before deployment.

A separate unbilled Google Cloud project Bundle Tek (project ID bundle-tek) was created in the signed-in account. Trador was not modified. Google Auth Platform branding is prepared but not saved: acceptance of Google's API Services User Data Policy and use of the signed-in support/contact email are waiting for explicit user approval. No OAuth client credentials exist yet. Nothing from this change is deployed.
