'use client';
import { createAuthClient } from 'better-auth/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
const auth = createAuthClient();
export function BundleAccount({
  googleEnabled = false,
}: {
  googleEnabled?: boolean;
}) {
  const { data: session, isPending } = auth.useSession();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ownerId = session?.user.id;
  const [googleLinkState, setGoogleLinkState] = useState<{
    ownerId: string;
    linked: boolean;
  } | null>(null);
  const googleLinked =
    googleEnabled && googleLinkState?.ownerId === ownerId
      ? (googleLinkState?.linked ?? null)
      : null;
  useEffect(() => {
    let cancelled = false;
    if (!ownerId || !googleEnabled) return;
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
  }, [ownerId, googleEnabled]);
  async function linkGoogle() {
    if (busy || !googleEnabled || !session || googleLinked !== false) return;
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
          {googleEnabled &&
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
      {error && <span role="alert">{error}</span>}
    </aside>
  );
}
