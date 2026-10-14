# Google sign-in

Announced UI scope: app/sign-in/page.tsx becomes a server wrapper and app/sign-in/sign-in-form.tsx owns the client form. Existing sign-in stylesheet adds a Google button above the email alternative. lib/auth.ts configures Better Auth Google only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both present. Existing password login remains available.

Production callback must be https://bundle-tek.vercel.app/api/auth/callback/google. Google requests only basic identity, uses an account selector, and requests online access without incremental scopes. Credentials are server-only. Automatic email-based account linking is disabled so an unverified password account cannot be silently linked. No new schema migration is needed.

Google Cloud credentials and live OAuth approval are pending. Do not claim Google login is live before those are configured and the callback is verified. No other UI components, wallet signing, provider credentials or deployments changed at this checkpoint.

Verification: 7 targeted tests pass across auth, request-origin guard and the sign-in form. They cover Google state/PKCE, exact callback, identity-only scopes, online access, malicious callback rejection, unconfigured-provider rejection, the button request payload and safe errors, plus the existing real libSQL password/session tests. Typecheck and typed lint pass. Production build passed compilation, TypeScript and page generation; its final trace result will be checked before deployment.

A separate unbilled Google Cloud project Bundle Tek (project ID bundle-tek) was created in the signed-in account. Trador was not modified. Google Auth Platform branding is prepared but not saved: acceptance of Google's API Services User Data Policy and use of the signed-in support/contact email are waiting for explicit user approval. No OAuth client credentials exist yet. Nothing from this change is deployed.


Continuation scope announced: app/layout.tsx passes only provider availability to components/bundle-account.tsx. Authenticated users can inspect whether Google is already linked and explicitly link the same Google email. Better Auth accountLinking is enabled with disableImplicitLinking=true. Existing user IDs and owner-scoped records remain unchanged. The Google policy approval is still pending; no new provider credentials, agreement acceptance or deployment occurred.


The user selected "I will review it in Chrome myself" for Google's policy. The browser tab remains handed off at the unchecked API Services User Data Policy step. No agreement was accepted and no OAuth client was created. Wait for the user's completion before resuming that provider setup.

Account-link continuation: 11 targeted tests pass across four files, including signed-out link rejection and server-owned state binding despite a forged link identity in additionalData. Typecheck/lint are checked on the final source. The final source production build passed, including TypeScript and page generation. Typed lint also passes. Provider availability is the only server value passed to account UI, with no client secret serialized. Main's existing two dirty files are preserved.
