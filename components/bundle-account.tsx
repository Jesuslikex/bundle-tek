'use client';
import { createAuthClient } from 'better-auth/react';
import Link from 'next/link';
import { useState } from 'react';
const auth = createAuthClient();
export function BundleAccount() {
  const { data: session, isPending } = auth.useSession();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (isPending) return null;
  return (
    <aside
      aria-label="Bundle account"
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 50,
        padding: '8px 12px',
        background: '#161720',
        border: '1px solid #383b4b',
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      {session ? (
        <>
          <span title={session.user.email}>{session.user.name}</span>{' '}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await auth.signOut();
                if (result.error) setError('Unable to sign out.');
                else window.location.assign('/sign-in');
              } catch {
                setError('Unable to connect.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out
          </button>
        </>
      ) : (
        <Link href="/sign-in">Sign in</Link>
      )}
      {error && <span role="alert">{error}</span>}
    </aside>
  );
}
