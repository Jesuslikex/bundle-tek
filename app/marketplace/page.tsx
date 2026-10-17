import Link from 'next/link';
import { MarketplacePanel } from '@/components/marketplace-panel';
import styles from '@/components/marketplace-panel.module.css';
export const metadata = { title: 'Wallet marketplace | Bundle Tek' };
export default function MarketplacePage() {
  return (
    <main className={styles.page}>
      <MarketplacePanel />
      <p className={styles.footer}>
        <Link href="/">Back to Bundle workspace</Link>
      </p>
    </main>
  );
}
