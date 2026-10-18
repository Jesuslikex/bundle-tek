# Production application release, 18 October 2026

The user explicitly requested deployment of the completed updates after observing the old 12-character password requirement. This authorizes this application release and its necessary non-destructive schema updates. It does not authorize funding, wallet signatures, blockchain transactions, token deployment, provider changes or enabling execution.

## Source and target

- Source archive: `e5bd8cfca3e57ab6fb1e405a2c92eac5b4c26a03`, the completed integrated Desktop Bundle product source. Later `f6800ad` is a coordination-note-only checkpoint. Preserved, uncommitted Claude UI work in the separate `Bundle-Claude-UI` checkout is excluded.
- Vercel project `bundle-tek`, ID `prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `team_M6GTUdujU7FPO7CZq29qETrG`, Node 24.x, production domain `https://bundle-tek.vercel.app/`.
- Before release, the production project reported deployment `dpl_4ocNd22BwNpvTsTeHyxTWDUMZ3Pa` at source `ea0a12044ae3cfc677c0a3ec61d160b6c2ca172f`. Actual Chrome registration DOM showed `minlength="12"`. Desktop source already has `ACCOUNT_MIN_PASSWORD_LENGTH = 8` and `VAULT_MIN_PASSWORD_LENGTH = 8`; the mismatch was stale production code.
- A clean Git archive supplies the deployment. No `.env` files, runtime databases, vaults, private keys, test artifacts or uncommitted UI changes are included. The source's deployment ignore rules exclude local tooling, docs and tests. Vercel's existing managed production configuration is preserved.

## Validation and database release

- Existing combined local production build and 291-test Volume selection passed at the source checkpoint. This release additionally reran the account/sign-in form, browser-vault crypto and mounted vault form checks: three files, 25 tests passed.
- Read-only production database inspection found the recognized migration ledger at 102 entries, through `0101_referrals`. Pending 0102..0107 contain no DROP TABLE, DELETE FROM or TRUNCATE statements. They add USD-target, exchange-funding and same-block Volume storage/guards; the complete 108-migration chain previously passed SQLite/Miniflare, local Turso and actual whole-file Wrangler validation.
- Production database audit and migration commands use Vercel's authenticated environment-run mechanism; credential values and environment-file contents are never printed or committed. The migration runner validates historical checksums and commits each migration with its ledger entry in a transaction.

## Release outcome

Production deployment **`dpl_77EbCVYdQ1paeNetY4R9BvVXfHw8` is READY and promoted** to `https://bundle-tek.vercel.app/`. Its immutable URL is `https://bundle-6eqynh3nt-jesuslikexs-projects.vercel.app/`. Remote compilation passed in 71 seconds, remote TypeScript in 59 seconds, and output generation/deployment completed at 04:26:24 UTC. The production alias API confirms both the public domain and project production alias belong to this deployment.

The six necessary production migrations succeeded: **108 total, 6 newly applied, 605 schema objects**. A fresh independent read-only audit confirms 108 entries through `0107_volume_bundle_recovery`, with no pending migrations. Historical checksums were validated by the runner. User data was not read or deleted.

Actual Chrome checks on the staged build and then the public production domain both show **“Use at least 8 characters.”** and `minlength="8"` on registration. No account was created, password changed, vault unlocked or wallet action taken. Wallet-vault crypto/form behavior is covered by the additional 25-test selection and deployed source; an authenticated production vault session was not exercised. Cropped live DOM screenshot: ignored `work/release-qa/live-password-8-20261018.jpg`.

Post-promotion anonymous HTTP checks: home 200, sign-in 200, auth session endpoint 200, imported projects 401, Pump groups 401. A deployment-scoped production log count over the recent 15-minute window returned no error/fatal groups. These are bounded release health checks, not a claim about funded behavior or long-term monitoring.

Two initial staged CLI requests from the archive directory nested inside the repository were returned as BLOCKED with Vercel's team-collaboration error link; neither was promoted or changed the database. The accepted manual deployment used the same source archive extracted outside the Git ancestor context and the authenticated project owner's existing CLI session. No Git author, account membership, plan, access policy or credential was changed. The live deployment above is the only promoted release from this task.

No execution gates, program-pin approvals, provider credentials, paid services, Git remotes or blockchain state are changed by this application release. Production program policies and the same-block Volume signing/execution contracts remain disabled.
