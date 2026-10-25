'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { SharedProjectReview } from './shared-project-review';
import {
  readSharedProjectSnapshots,
  type SharedProjectSnapshot,
} from '@/lib/shared-project-review';
import { readWorkspaceResponse } from '@/lib/workspace-response';

type Share = {
  id: string;
  accepted: boolean;
  createdAt: string;
  acceptedAt: string | null;
};
type SharedProject = SharedProjectSnapshot;

async function call<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/projects/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(value.error || 'Sharing unavailable.');
  return value;
}
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Sharing unavailable.';

async function fetchShares(projectId: string) {
  const response = await fetch(
    `/api/projects/shares?projectId=${encodeURIComponent(projectId)}`,
    { cache: 'no-store' },
  );
  const value = (await readWorkspaceResponse(
    response,
    'Shares unavailable. Try again later.',
    'Sign in to review project shares.',
  )) as { shares?: Share[]; error?: string };
  if (!response.ok || !value.shares)
    throw new Error(value.error || 'Shares unavailable.');
  return value.shares;
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
  const load = useCallback(
    () => fetchShares(projectId).then(setShares, (e) => setError(message(e))),
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function run(action: () => Promise<void>) {
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
  return (
    <section aria-label="Collaborators" className="min-w-0 space-y-2">
      <h4>Collaborators</h4>
      <p className="text-xs text-muted-foreground">
        Share a read-only view of this project. Collaborators receive the saved
        plan, including public wallet assignments. Private keys and signing stay
        with you.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const { share } = await call<{
              share: { token: string };
            }>({ action: 'invite', projectId });
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
          now: <code className="break-all">{link}</code>
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
