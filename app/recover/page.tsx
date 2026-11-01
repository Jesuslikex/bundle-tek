import Link from 'next/link';
import { RecoverFunds } from '@/components/recover-funds';
import styles from '@/components/recover-funds.module.css';
export const metadata = { title: 'Recover Funds | Bundle Tek' };
export default function RecoverPage() {
  return (
    <main
      style={{ minHeight: '100dvh', maxHeight: '100dvh', overflowY: 'auto' }}
    >
      <RecoverFunds />
      <p className={styles.footer}>
        <Link href="/">Back to Bundle workspace</Link>
      </p>
    </main>
  );
}
