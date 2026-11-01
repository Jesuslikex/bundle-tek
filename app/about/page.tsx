import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '../privacy/privacy.module.css';

export const metadata: Metadata = {
  title: 'About | Bundle Tek',
  description: 'Token launch planning, wallet management and trading tools.',
};

export default function AboutPage() {
  return (
    <main className={styles.page}>
      <nav aria-label="About navigation">
        <Link href="/">Open Bundle Tek</Link>
        <Link href="/privacy">Privacy notice</Link>
      </nav>
      <h1>Bundle Tek</h1>
      <p>
        Bundle Tek provides token launch planning, wallet management, market
        observations and transaction review tools. Features have different
        availability and verification requirements. Review the status and
        transaction details shown in the app before approving any wallet action.
      </p>
      <h2>Your account</h2>
      <p>
        Sign in to access your saved projects. When enabled, Google sign-in uses
        your basic account identity to authenticate your Bundle account. It does
        not authorize wallet transactions or provide access to Gmail or Drive.
      </p>
      <p>
        <Link href="/sign-in">Sign in to Bundle Tek</Link>
      </p>
      <p>
        Read our <Link href="/privacy">privacy notice</Link> for details about
        account information, service providers, browser vaults and your choices.
      </p>
    </main>
  );
}
