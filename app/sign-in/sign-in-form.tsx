'use client';
import { createAuthClient } from 'better-auth/react';
import { useState } from 'react';
import Link from 'next/link';
import styles from './sign-in.module.css';
import { WalletLogin } from './wallet-login';
import { ACCOUNT_MIN_PASSWORD_LENGTH } from '@/lib/account-password-policy';
function value(form: FormData, name: string) {
  const field = form.get(name);
  if (typeof field !== 'string') throw new Error('Invalid form field');
  return field;
}
const auth = createAuthClient();
export function SignInForm({
  googleEnabled,
  initialError = '',
}: {
  googleEnabled: boolean;
  initialError?: string;
}) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const data = {
        email: value(form, 'email'),
        password: value(form, 'password'),
      };
      const result = register
        ? await auth.signUp.email({ ...data, name: value(form, 'name') })
        : await auth.signIn.email(data);
      if (result.error) setError(result.error.message || 'Unable to sign in.');
      else window.location.assign('/');
    } catch {
      setError('Unable to connect. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function googleSignIn() {
    if (busy || !googleEnabled) return;
    setBusy(true);
    setError('');
    try {
      const result = await auth.signIn.social({
        provider: 'google',
        callbackURL: '/',
        errorCallbackURL: '/sign-in?error=google',
      });
      if (result.error) {
        setError(result.error.message || 'Google sign-in is unavailable.');
        setBusy(false);
      }
    } catch {
      setError('Unable to connect to Google sign-in.');
      setBusy(false);
    }
  }
  return (
    <main className={styles.panel}>
      <Link href="/">Bundle Tek</Link>
      <h1>{register ? 'Create your account' : 'Sign in'}</h1>
      <p>
        This is your new Bundle account. Previous Sites accounts and saved data
        are separate.
      </p>
      {googleEnabled && (
        <>
          <button
            type="button"
            className={styles.google}
            disabled={busy}
            onClick={googleSignIn}
          >
            <span aria-hidden="true">G</span> Continue with Google
          </button>
          <p>
            Already use email? Sign in first, then link Google from your
            account.
          </p>
        </>
      )}
      <WalletLogin busy={busy} setBusy={setBusy} onError={setError} />
      <div className={styles.divider}>or use email</div>
      <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        {register && (
          <label>
            Name
            <input name="name" required maxLength={80} autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={register ? ACCOUNT_MIN_PASSWORD_LENGTH : undefined}
            maxLength={128}
            aria-describedby={register ? 'account-password-help' : undefined}
            autoComplete={register ? 'new-password' : 'current-password'}
          />
        </label>
        {register && (
          <p id="account-password-help">
            Use at least {ACCOUNT_MIN_PASSWORD_LENGTH} characters.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button disabled={busy} type="submit">
          {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setRegister(!register);
          setError('');
        }}
      >
        {register ? 'Already have an account? Sign in' : 'Create an account'}
      </button>
      <Link href="/" className={styles.back}>
        ← Continue without signing in
      </Link>
    </main>
  );
}
