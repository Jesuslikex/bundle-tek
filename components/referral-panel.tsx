'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Ticket, UserPlus } from 'lucide-react';

type Summary = {
  code: string | null;
  referredCount: number;
  referredBy: { code: string; at: string } | null;
};

/**
 * Referral codes and who joined through them. Bundle takes no trading fees, so
 * this tracks referrals only; there is nothing to pay out.
 */
export function ReferralPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/referrals', { cache: 'no-store' });
      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      const data = (await response.json()) as Summary & { error?: string };
      if (!response.ok) {
        setError(data?.error ?? 'Referrals temporarily unavailable.');
        return;
      }
      setSignedOut(false);
      setSummary(data);
    } catch {
      setError('Referrals temporarily unavailable.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(action: 'create' | 'apply', value?: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/referrals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value ? { action, code: value } : { action }),
      });
      const data = (await response.json()) as Summary & { error?: string };
      if (!response.ok) {
        setError(data?.error ?? 'Referrals temporarily unavailable.');
        return;
      }
      setSummary(data);
      setCode('');
      setNotice(
        action === 'create' ? 'Referral code created.' : 'Referral code applied.',
      );
    } catch {
      setError('Referrals temporarily unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!summary?.code) return;
    const value = summary.code;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API is unavailable on insecure origins and in some webviews.
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) {
        setError('Could not copy the code.');
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="referral-panel">
      <div className="page-title">
        <span className="eyebrow">REFERRALS</span>
        <h1>Invite people to Bundle</h1>
        <p>
          Share a code. Bundle takes no trading fees, so referrals are tracked
          only, with nothing to pay out.
        </p>
      </div>

      {signedOut ? (
        <div className="referral-card">
          <Ticket size={16} />
          <h2>Sign in to use referrals</h2>
          <p>Codes are tied to your account.</p>
        </div>
      ) : (
        <>
          <div className="referral-card">
            <Ticket size={16} />
            <h2>Your code</h2>
            {summary?.code ? (
              <>
                <div className="referral-code">
                  <code>{summary.code}</code>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    aria-label="Copy referral code"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="referral-muted">
                  {summary.referredCount === 1
                    ? '1 person joined through your code.'
                    : `${summary.referredCount} people joined through your code.`}
                </p>
              </>
            ) : (
              <>
                <p className="referral-muted">
                  You do not have a code yet. Creating one is instant.
                </p>
                <button
                  type="button"
                  className="referral-primary"
                  disabled={busy}
                  onClick={() => void send('create')}
                >
                  Create my code
                </button>
              </>
            )}
          </div>

          <div className="referral-card">
            <UserPlus size={16} />
            <h2>Were you invited?</h2>
            {summary?.referredBy ? (
              <p className="referral-muted">
                Applied <code>{summary.referredBy.code}</code> on{' '}
                {new Date(summary.referredBy.at).toLocaleDateString()}.
              </p>
            ) : (
              <form
                className="referral-apply"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (code.trim()) void send('apply', code.trim());
                }}
              >
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="ABCD2345"
                  aria-label="Referral code"
                  maxLength={8}
                />
                <button type="submit" disabled={busy || code.trim().length !== 8}>
                  Apply
                </button>
              </form>
            )}
          </div>
        </>
      )}

      {notice && <p className="referral-notice">{notice}</p>}
      {error && (
        <p className="referral-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
