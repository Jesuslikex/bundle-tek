# Bundle Tek Vercel migration started

The user selected a separate Vercel deployment and a fresh database, preserving CROP's existing Site and records. No support contact is authorized. The CROP migration failure remains unresolved; this work uses a new runtime and database instead.

## Isolated source and resource

Git branch: codex/bundle-vercel, based on committed main 19caee1. Checkout: C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/sites/bundle-vercel. Main's unrelated whitespace changes were not copied or changed.

Vercel team: jesuslikex's projects, ID team_M6GTUdujU7FPO7CZq29qETrG. Connector access and CLI identity jesuslikex were verified. No existing Bundle project was found. New project bundle-tek was created with Next.js framework, ID prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS. It is linked locally through ignored .vercel/project.json. The project has no deployment or live domain. Its existing deployment protection was preserved.

The Vercel CLI created ignored .env.local containing its managed OIDC configuration. No key/token values were read or printed. Turso integration guide was fetched, then installation started using vercel integration add tursocloud/database --no-claim. The CLI is waiting for the user to accept the provider's terms at https://vercel.com/jesuslikexs-projects/~/integrations/accept-terms/tursocloud?source=cli . The user must perform this agreement step. Use the Free plan; do not accept a paid option or subscription. No Turso database or application authentication has been verified yet.

## Implementation sequence after provisioning

1. Verify the selected project and fresh database resource, its region/plan and injected environment key names without printing values.
2. Add a libSQL database adapter preserving the application's D1 prepare/bind/first/all/batch behavior, exact scalar/blob values, atomic batches and trigger enforcement. Verify all 80 main migrations against a disposable SQLite/libSQL database before applying to the new empty resource. Do not carry CROP's seven unrelated legacy migrations or partial database into this fresh app.
3. Migrate Vinext/Cloudflare build and runtime to supported Next.js/Vercel. Replace Sites-authenticated header trust with real session authentication. Never accept caller-supplied oai-authenticated headers on Vercel.
4. Verify private image upload, explicit public metadata/image snapshots, launch approvals, wallet reservations and lost-response recovery through the real new adapter and authenticated routes. Keep existing user-approved browser signing and broadcast separation.
5. Port the scheduled preparation/conditional-monitor entrypoints to authenticated Vercel jobs with existing bounded behavior, replay guards and no automatic signing.
6. Configure hosted providers through supported secret management, build and test, deploy a protected preview, inspect rendered desktop/mobile behavior, then publish the reviewed production result. User performs any funded signing/broadcast tests.

No application code, migrations, SDK dependencies, runtime DB, CROP source, hosted Site, private wallet keys, signing or transaction changed in this initial checkpoint. The work is not yet deployable. Backend/database/auth migration has not been implemented. Continue after provider terms acceptance, not by substituting mocks or starting an unconfigured server.
