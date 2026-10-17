'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Summary = {
  code: string | null;
  referredCount: number;
  referredBy: { code: string; at: string } | null;
};
const PENDING_KEY = 'bundle.referral-code.v1';

async function request(init?: RequestInit): Promise<Summary | null> {
  const response = await fetch('/api/referrals', {
    cache: 'no-store',
    ...init,
  });
  if (response.status === 401) return null;
  const value = (await response.json().catch(() => ({}))) as Summary & {
    error?: string;
  };
  if (!response.ok) throw new Error(value.error || 'Referrals unavailable.');
  return value;
}
const post = (body: unknown) =>
  request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Referrals unavailable.';

export function ReferralPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void request().then(
      (value) => {
        // A ?ref= link prefills the code; applying it still takes a click.
        const fromUrl = new URLSearchParams(window.location.search).get('ref');
        let pending = fromUrl;
        try {
          if (fromUrl) localStorage.setItem(PENDING_KEY, fromUrl);
          else pending = localStorage.getItem(PENDING_KEY);
        } catch {}
        if (pending) setEntry(pending.toUpperCase().slice(0, 8));
        setSummary(value);
      },
      (e) => setError(message(e)),
    );
  }, []);
  async function run(action: () => Promise<Summary | null>) {
    setBusy(true);
    setError('');
    try {
      const value = await action();
      if (value) setSummary(value);
      return value;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  if (!summary) return error ? <p role="alert">{error}</p> : null;
  const link =
    summary.code && typeof window !== 'undefined'
      ? `${window.location.origin}/?ref=${summary.code}`
      : '';
  return (
    <section aria-label="Referrals" className="min-w-0 space-y-2">
      <h3>Referrals</h3>
      {summary.code ? (
        <>
          <p>
            Your code <strong>{summary.code}</strong> · {summary.referredCount}{' '}
            account
            {summary.referredCount === 1 ? '' : 's'} joined with it.
          </p>
          <p>
            <code className="break-all">{link}</code>{' '}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(link)
                  .then(() => setCopied(true))
                  .catch(() => setError('Copy the link manually.'))
              }
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </p>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => post({ action: 'create' }))}
        >
          Get my referral link
        </Button>
      )}
      {summary.referredBy ? (
        <p className="text-xs text-muted-foreground">
          You joined with code {summary.referredBy.code}.
        </p>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => post({ action: 'apply', code: entry })).then(
              (value) => {
                if (value?.referredBy)
                  try {
                    localStorage.removeItem(PENDING_KEY);
                  } catch {}
              },
            );
          }}
        >
          <Input
            aria-label="Referral code"
            placeholder="Referral code"
            value={entry}
            maxLength={8}
            onChange={(e) => setEntry(e.target.value.toUpperCase())}
            className="w-40"
          />
          <Button type="submit" variant="outline" disabled={busy || !entry}>
            Apply code
          </Button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
