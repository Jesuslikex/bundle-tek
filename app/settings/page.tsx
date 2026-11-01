import Link from 'next/link';
import { UserSettingsPanel } from '@/components/user-settings-panel';
import styles from '@/components/user-settings-panel.module.css';
export const metadata = { title: 'Settings | Bundle Tek' };
export default function SettingsPage() {
  return (
    <main
      style={{ minHeight: '100dvh', maxHeight: '100dvh', overflowY: 'auto' }}
    >
      <UserSettingsPanel />
      <p className={styles.footer}>
        <Link href="/">Back to Bundle workspace</Link>
      </p>
    </main>
  );
}
