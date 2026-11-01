import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './privacy.module.css';

export const metadata: Metadata = {
  title: 'Privacy | Bundle Tek',
  description: 'How Bundle Tek uses account, wallet and project information.',
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <nav aria-label="Privacy navigation">
        <Link href="/">Bundle Tek</Link>
        <Link href="/sign-in">Sign in</Link>
      </nav>
      <h1>Privacy notice</h1>
      <p>Updated 1 November 2026</p>
      <p>
        Bundle Tek provides token launch planning, wallet management and trading
        tools. This notice explains the information used by those tools and by
        Google sign-in.
      </p>
      <h2>Google sign-in and account information</h2>
      <p>
        When you choose Google sign-in, Bundle Tek receives your Google account
        identifier, name, email address, email verification status and profile
        picture when supplied by Google. We use this information to create or
        authenticate your Bundle account and show your account identity. Google
        sign-in does not grant access to your Gmail, Drive, contacts or wallet
        funds.
      </p>
      <p>
        Account records and sessions are stored on the server. Authentication
        records can include provider tokens, token expiry information and
        granted scopes. Session records can include your IP address, browser
        information and expiry. Email-password accounts store a password hash,
        rather than a readable password. Google sign-in does not give Bundle
        your Google password.
      </p>
      <h2>Projects, wallets and transaction records</h2>
      <p>
        We store information you save in the app, including project settings,
        public wallet addresses, launch artwork, reviews, approvals and
        transaction or recovery records. Saved wallet addresses can be
        associated with your account. Public blockchain activity remains public,
        including when an account or local browser data is removed.
      </p>
      <p>
        Browser wallet vaults keep encrypted wallet material in your browser.
        Marketplace key delivery is a separate feature: delivered wallet keys
        are encrypted on the server using a deployment secret. That encryption
        protects stored data; it does not make the server unable to decrypt
        those keys or prove that a previous key holder retained no copy.
      </p>
      <h2>Service providers and public information</h2>
      <p>
        Vercel hosts the application, Turso stores server data, and Google
        processes Google sign-in. When you request market data, quotes,
        simulation or blockchain actions, configured RPC, indexer, exchange and
        transaction providers receive the information needed for that request,
        such as public addresses, token identifiers and transaction data.
        Provider policies also apply to their processing.
      </p>
      <p>
        Launch metadata and artwork you explicitly publish can be publicly
        accessible. Information you share with project collaborators is visible
        within the applicable project permissions. Do not put secrets in public
        artwork, descriptions or project names.
      </p>
      <h2>Cookies, browser storage and security</h2>
      <p>
        Bundle uses authentication cookies and browser storage for sessions,
        wallet vaults and saved local preferences or recovery information.
        Hosting and service providers may retain operational and security logs.
        Protect your account, device and wallet backups; clearing browser
        storage can remove local wallet material.
      </p>
      <h2>Retention and your choices</h2>
      <p>
        Saved account, project and transaction records remain stored until
        removed through supported controls or an operator-assisted request. Some
        financial evidence is append-only, and on-chain records cannot be erased
        by Bundle. This notice does not promise immediate deletion of backups,
        provider logs or immutable records.
      </p>
      <p>
        You can choose email or wallet sign-in instead of Google. You can revoke
        Google access in your Google account; revoking it does not itself delete
        an existing Bundle account. To request access, correction or deletion,
        contact the operator at{' '}
        <a href="mailto:juliancool48653@googlemail.com">
          juliancool48653@googlemail.com
        </a>
        . Never include a wallet seed phrase, private key, password or access
        token in a support request.
      </p>
    </main>
  );
}
