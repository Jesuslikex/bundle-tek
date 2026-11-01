'use client';
import { createAuthClient } from 'better-auth/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { UserThemeSync } from './user-theme-sync';
const auth = createAuthClient();
export function BundleAccount({
  googleEnabled = false,
}: {
  googleEnabled?: boolean;
}) {
  const { data: session, isPending } = auth.useSession();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ownerId = session?.user.id;
  const canLinkGoogle = googleEnabled && !ownerId?.startsWith('solana_');
  const [googleLinkState, setGoogleLinkState] = useState<{
    ownerId: string;
    linked: boolean;
  } | null>(null);
  const googleLinked =
    canLinkGoogle && googleLinkState?.ownerId === ownerId
      ? (googleLinkState?.linked ?? null)
      : null;
  useEffect(() => {
    let cancelled = false;
    if (!ownerId || !canLinkGoogle) return;
    void auth
      .listAccounts()
      .then((result) => {
        if (cancelled) return;
        if (result.error || !result.data) {
          setError('Unable to read linked accounts.');
          return;
        }
        setGoogleLinkState({
          ownerId,
          linked: result.data.some(
            (account) => account.providerId === 'google',
          ),
        });
      })
      .catch(() => {
        if (!cancelled) setError('Unable to read linked accounts.');
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, canLinkGoogle]);
  async function linkGoogle() {
    if (busy || !canLinkGoogle || !session || googleLinked !== false) return;
    setBusy(true);
    setError('');
    try {
      const result = await auth.linkSocial({
        provider: 'google',
        callbackURL: '/',
        errorCallbackURL: '/sign-in?error=google',
      });
      if (result.error) {
        setError(
          'Unable to link Google. Use the Google account with your Bundle email.',
        );
        setBusy(false);
      }
    } catch {
      setError('Unable to connect to Google.');
      setBusy(false);
    }
  }
  // The sign-in page has its own form; a floating "Sign in" link there is redundant.
  if (isPending || pathname === '/sign-in') return <UserThemeSync />;
  return (
    <>
      <UserThemeSync />
      <aside
        aria-label="Bundle account"
        style={{
          position: 'fixed',
          bottom: 12,
          right: 12,
          zIndex: 50,
          padding: '8px 12px',
          background: 'var(--card, #161720)',
          color: 'var(--foreground, #fcfcfc)',
          border: '1px solid var(--border, #383b4b)',
          borderRadius: 8,
          fontSize: 12,
          maxWidth: 'calc(100vw - 24px)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {session ? (
          <>
            <span title={session.user.email}>{session.user.name}</span>{' '}
            {canLinkGoogle &&
              (googleLinked === true ? (
                <span>Google linked</span>
              ) : (
                <button
                  disabled={busy || googleLinked === null}
                  onClick={linkGoogle}
                >
                  {googleLinked === null ? 'Checking Google…' : 'Link Google'}
                </button>
              ))}
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
        {pathname !== '/settings' && <Link href="/settings">Settings</Link>}
        {session && pathname !== '/recover' && (
          <Link href="/recover">Recover funds</Link>
        )}
        {error && <span role="alert">{error}</span>}
      </aside>
    </>
  );
}
