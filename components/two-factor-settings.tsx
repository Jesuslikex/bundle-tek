'use client';
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { useState } from 'react';
import styles from './user-settings-panel.module.css';

const auth = createAuthClient({ plugins: [twoFactorClient()] });

/** Authenticator-app 2FA for email/password sign-in, with backup codes. */
export function TwoFactorSettings() {
  const { data: session, refetch } = auth.useSession();
  const enabled = Boolean(
    (session?.user as { twoFactorEnabled?: boolean | null } | undefined)
      ?.twoFactorEnabled,
  );
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{
    uri: string;
    secret: string;
    backupCodes: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch {
      setError('Unable to connect. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const enable = () =>
    run(async () => {
      const r = await auth.twoFactor.enable({ password });
      if (r.error || !r.data || !('totpURI' in r.data) || !r.data.totpURI) {
        setError(r.error?.message || 'Could not start 2FA setup.');
        return;
      }
      setPassword('');
      setSetup({
        uri: r.data.totpURI,
        secret: new URL(r.data.totpURI).searchParams.get('secret') ?? '',
        backupCodes: r.data.backupCodes ?? [],
      });
    });
  const confirm = () =>
    run(async () => {
      const r = await auth.twoFactor.verifyTotp({ code: code.trim() });
      if (r.error) {
        setError(
          r.error.message || 'Wrong code. Check the time on your phone.',
        );
        return;
      }
      setSetup(null);
      setCode('');
      setNotice('Two-factor is on. Email sign-in now asks for a code.');
      await refetch();
    });
  const disable = () =>
    run(async () => {
      const r = await auth.twoFactor.disable({ password });
      if (r.error) {
        setError(r.error.message || 'Could not turn off 2FA.');
        return;
      }
      setPassword('');
      setNotice('Two-factor is off.');
      await refetch();
    });
  if (!session) return <p>Sign in to set up two-factor.</p>;
  return (
    <>
      <p>
        Protects email and password sign-in with a 6-digit code from an
        authenticator app (Google Authenticator, Authy, 1Password). Wallet and
        Google sign-in are not affected.
      </p>
      <p>
        Status: <strong>{enabled ? 'On' : 'Off'}</strong>
      </p>
      {setup ? (
        <>
          <p>
            Add this key to your authenticator app (manual entry, time-based),
            then enter the code it shows.
          </p>
          <code className={styles.json} aria-label="Authenticator key">
            {setup.secret}
          </code>
          <p>
            <a href={setup.uri}>Open in authenticator app</a>
          </p>
          <p>
            Save these backup codes somewhere safe. Each works once if you lose
            your phone:
          </p>
          <textarea
            className={styles.json}
            aria-label="Backup codes"
            readOnly
            value={setup.backupCodes.join('\n')}
          />
          <div className={styles.actions}>
            <input
              className={styles.text}
              aria-label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="button" disabled={busy || !code} onClick={confirm}>
              Confirm and turn on
            </button>
          </div>
        </>
      ) : (
        <div className={styles.actions}>
          <input
            className={styles.text}
            type="password"
            aria-label="Account password"
            placeholder="Account password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {enabled ? (
            <button
              type="button"
              disabled={busy || !password}
              onClick={disable}
            >
              Turn off 2FA
            </button>
          ) : (
            <button type="button" disabled={busy || !password} onClick={enable}>
              Set up 2FA
            </button>
          )}
        </div>
      )}
      {notice && <output>{notice}</output>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  );
}
