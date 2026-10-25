'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { SharedProjectReview } from './shared-project-review';
import {
  readSharedProjectSnapshots,
  type SharedProjectSnapshot,
} from '@/lib/shared-project-review';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  readShareExpiry,
  SHARE_EXPIRY_OPTIONS,
} from '@/lib/project-share-expiry';

type Share = {
  id: string;
  accepted: boolean;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
};
type SharedProject = SharedProjectSnapshot;

async function call<T>(body: unknown): Promise<T> {
  const signal = AbortSignal.timeout(15000);
  const response = await fetch('/api/projects/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    if (response.status === 409) {
      const value = (await readBoundedPanelJson(response, signal).catch(
        () => null,
      )) as { error?: unknown } | null;
      const messages = [
        'Ask the owner to revoke your expired share before accepting a new invite.',
        'You already have a share for this project. Refresh shared projects.',
        'This invite was already used.',
        'This is your own project.',
        'Up to 10 shares per project.',
      ];
      if (typeof value?.error === 'string' && messages.includes(value.error))
        throw new Error(value.error);
    } else void response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? 'Sign in to manage project shares.'
        : response.status === 404
          ? 'Project or invite unavailable, expired or revoked.'
          : 'Sharing unavailable. Refresh shares before repeating this action.',
    );
  }
  return (await readBoundedPanelJson(response, signal)) as T;
}
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Sharing unavailable.';

async function fetchShares(projectId: string, signal: AbortSignal) {
  const response = await fetch(
    `/api/projects/shares?projectId=${encodeURIComponent(projectId)}`,
    { cache: 'no-store', signal },
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? 'Sign in to review project shares.'
        : 'Shares unavailable. Try again later.',
    );
  }
  const value = (await readBoundedPanelJson(response, signal)) as {
    shares?: Share[];
  } | null;
  if (!value || !Array.isArray(value.shares) || value.shares.length > 10)
    throw new Error('Shares unavailable. Try again later.');
  const seen = new Set<string>();
  return value.shares.map((s) => {
    if (
      !s ||
      typeof s.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(s.id) ||
      seen.has(s.id) ||
      typeof s.accepted !== 'boolean' ||
      typeof s.expired !== 'boolean' ||
      typeof s.createdAt !== 'string' ||
      (s.acceptedAt !== null && typeof s.acceptedAt !== 'string')
    )
      throw new Error('Shares unavailable. Try again later.');
    readShareExpiry(s.createdAt);
    readShareExpiry(s.acceptedAt);
    if (
      s.accepted !== (s.acceptedAt !== null) ||
      (s.expiresAt === null && s.expired)
    )
      throw new Error('Shares unavailable. Try again later.');
    seen.add(s.id);
    return { ...s, expiresAt: readShareExpiry(s.expiresAt) };
  });
}
async function fetchSharedProjects(signal: AbortSignal) {
  const response = await fetch('/api/projects/shares', {
    cache: 'no-store',
    signal,
  });
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  return readSharedProjectSnapshots(response, signal);
}

/** Owner view: invite collaborators to read this saved project. */
export function ProjectSharePanel({ projectId }: { projectId: string }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [duration, setDuration] = useState(86400);
  const [linkExpiry, setLinkExpiry] = useState('');
  const generation = useRef(0),
    mutation = useRef(0),
    mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const version = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const shares = await fetchShares(
        projectId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (mounted.current && version === generation.current) {
        setShares(shares);
        setError('');
      }
    } catch (e) {
      if (
        mounted.current &&
        version === generation.current &&
        !controller.signal.aborted
      )
        setError(
          e instanceof Error &&
            e.message === 'Sign in to review project shares.'
            ? e.message
            : 'Shares unavailable. Try again later.',
        );
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [projectId]);
  const cancelRead = useCallback(() => {
    mounted.current = false;
    generation.current++;
    mutation.current++;
    pending.current?.abort();
  }, []);
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) void load();
    });
    return cancelRead;
  }, [load, cancelRead]);
  async function run(action: (current: () => boolean) => Promise<void>) {
    const operation = ++mutation.current;
    const current = () => mounted.current && mutation.current === operation;
    generation.current++;
    pending.current?.abort();
    setBusy(true);
    setError('');
    try {
      setLink('');
      setLinkExpiry('');
      await action(current);
      if (current()) await load();
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section aria-label="Collaborators" className="min-w-0 space-y-2">
      <h4>Collaborators</h4>
      <p className="text-xs text-muted-foreground">
        Share a read-only view of this project. Collaborators receive the saved
        plan, including public wallet assignments. Private keys and signing stay
        with you.
      </p>
      <p>
        Expiry ends future shared reads, including after an invite is accepted.
        Already viewed or copied plans cannot be recalled. Expired shares still
        count toward the 10-share limit until revoked. Revoke an expired
        collaborator share before inviting that person again.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void load()}
      >
        Refresh shares
      </Button>
      <p>
        If creating an invite is interrupted, refresh this list and revoke the
        unused invite before creating another. A lost invite token cannot be
        recovered.
      </p>
      <label>
        Share access duration{' '}
        <select
          aria-label="Share access duration"
          disabled={busy}
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
        >
          {SHARE_EXPIRY_OPTIONS.map((option) => (
            <option key={option.seconds} value={option.seconds}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(async (current) => {
            const { share } = await call<{
              share: { token: string; expiresAt: string };
            }>({ action: 'invite', projectId, expiresInSeconds: duration });
            let expiry: string | null = null;
            try {
              expiry = readShareExpiry(share?.expiresAt);
            } catch {
              /* Refuse an unbound or malformed invite. */
            }
            if (
              !share ||
              typeof share.token !== 'string' ||
              !/^[A-Za-z0-9_-]{43}$/.test(share.token) ||
              expiry === null
            )
              throw new Error(
                'Invite response unavailable. Refresh shares before creating another invite.',
              );
            if (!current()) return;
            setLinkExpiry(expiry);
            setLink(
              `${window.location.origin}/?share=${encodeURIComponent(share.token)}`,
            );
          })
        }
      >
        Create invite link
      </Button>
      {link && (
        <p>
          Send this link to one collaborator. It works once and is shown only
          now: <code className="break-all">{link}</code> Access ends{' '}
          <time dateTime={linkExpiry}>
            {new Date(linkExpiry).toLocaleString()}
          </time>
          .
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {shares.length > 0 && (
        <ul className="space-y-1 text-sm">
          {shares.map((s) => (
            <li key={s.id}>
              {s.accepted
                ? `Collaborator joined ${new Date(s.acceptedAt!).toLocaleString()}`
                : `Unused invite from ${new Date(s.createdAt).toLocaleString()}`}{' '}
              {s.expiresAt === null ? (
                'No expiry (legacy share). Revoke to end access.'
              ) : (
                <>
                  {s.expired ? 'Expired' : 'Access ends'}{' '}
                  <time dateTime={s.expiresAt}>
                    {new Date(s.expiresAt).toLocaleString()}
                  </time>
                  .
                </>
              )}{' '}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    call({ action: 'revoke', id: s.id }).then(() => undefined),
                  )
                }
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Collaborator view: accept an invite from the URL and list shared projects. */
export function SharedProjectsPanel() {
  const [projects, setProjects] = useState<SharedProject[]>([]);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const expiries = projects.flatMap((p) =>
      p.expiresAt ? [Date.parse(p.expiresAt)] : [],
    );
    if (!expiries.length) return;
    const timer = setTimeout(
      () =>
        setProjects((current) =>
          current.filter(
            (p) => !p.expiresAt || Date.parse(p.expiresAt) > Date.now(),
          ),
        ),
      Math.min(2147483647, Math.max(1, Math.min(...expiries) - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [projects]);
  const load = useCallback(async () => {
    const version = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    let signal: AbortSignal | undefined;
    const current = () => mounted.current && generation.current === version;
    try {
      if (
        typeof AbortSignal.any !== 'function' ||
        typeof AbortSignal.timeout !== 'function'
      )
        throw Error(
          'This browser cannot time-limit project reads. Update your browser to continue.',
        );
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const value = await fetchSharedProjects(signal);
      if (!current()) return;
      setProjects(value ?? []);
      setError(value === null ? 'Sign in to open shared projects.' : '');
      const fromUrl = new URLSearchParams(window.location.search).get('share');
      if (fromUrl) setToken(fromUrl);
    } catch (error) {
      // Capability failures are also asynchronous read outcomes, never a
      // synchronous state update from the mounting effect.
      await Promise.resolve();
      if (!current()) return;
      setProjects([]);
      setError(
        signal?.aborted
          ? 'Shared projects read interrupted. Try again.'
          : message(error),
      );
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, []);
  const cancelRead = useCallback(() => {
    mounted.current = false;
    generation.current++;
    pending.current?.abort();
  }, []);
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) void load();
    });
    return cancelRead;
  }, [load, cancelRead]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!token && !projects.length && !error) return null;
  return (
    <section aria-label="Shared with you" className="min-w-0 space-y-2">
      <h3>Shared with you</h3>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void run(async () => {})}
      >
        Refresh shared projects
      </Button>
      {token && (
        <p>
          You opened a project invite.{' '}
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await call({ action: 'accept', token });
                setToken('');
                const url = new URL(window.location.href);
                url.searchParams.delete('share');
                window.history.replaceState(null, '', url);
              })
            }
          >
            Accept invite
          </Button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.shareId}>
            <strong>{p.plan.tokenName}</strong> ${p.plan.ticker} ·{' '}
            {p.plan.chain} · {p.plan.launchpad} · updated{' '}
            {new Date(p.updatedAt).toLocaleString()}
            {p.archived ? ' · archived' : ''} · read only{' '}
            <p>
              {p.expiresAt === undefined ? (
                'Expiry not supplied by this server. Refresh to check access.'
              ) : p.expiresAt === null ? (
                'No expiry (legacy share). The owner can revoke access.'
              ) : (
                <>
                  Access ends{' '}
                  <time dateTime={p.expiresAt}>
                    {new Date(p.expiresAt).toLocaleString()}
                  </time>
                  .
                </>
              )}
            </p>
            <SharedProjectReview project={p} />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => call({ action: 'leave', id: p.shareId }))
              }
            >
              Leave
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
