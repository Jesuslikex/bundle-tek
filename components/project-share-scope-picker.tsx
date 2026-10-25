'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  readProjectShareScope,
  type ProjectShareScope,
  type ProjectShareWallet,
} from '@/lib/project-share-scope';
import styles from './project-share-scope-picker.module.css';

type Props = {
  projectId: string;
  busy: boolean;
  onChange: (scope: ProjectShareScope | null) => void;
};
const keyFor = (wallet: ProjectShareWallet) =>
  `${wallet.chain}:${wallet.address}:${wallet.revision}:${wallet.role}`;

/** Exact public assignment references only. This does not delegate wallets. */
export function ProjectShareScopePicker(props: Props) {
  return <ScopePicker key={props.projectId} {...props} />;
}

function ScopePicker({ projectId, busy, onChange }: Props) {
  const id = useId();
  const [source, setSource] = useState<ProjectShareScope | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);

  async function load() {
    if (busy || loading) return;
    const version = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = () =>
      mounted.current &&
      version === generation.current &&
      !controller.signal.aborted;
    setLoading(true);
    setError('');
    setSource(null);
    setSelected([]);
    onChange(null);
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      const response = await fetch(
        `/api/projects/shares?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store', signal },
      );
      if (!current()) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw Error(
          response.status === 401
            ? 'Sign in to choose saved wallet assignments.'
            : response.status === 404
              ? 'Saved project assignments are unavailable.'
              : 'Wallet assignments unavailable. Load them again before selecting any.',
        );
      }
      const value = (await readBoundedPanelJson(response, signal)) as {
        source?: unknown;
      } | null;
      if (!current()) return;
      const candidate = value?.source;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(',') !==
          'candidates,projectId,projectRevision' ||
        (candidate as { projectId?: unknown }).projectId !== projectId
      )
        throw Error('Saved project assignments are unavailable.');
      const raw = candidate as {
        projectRevision: unknown;
        candidates: unknown;
      };
      const parsed = readProjectShareScope({
        format: 'project-share-wallet-scope-v1',
        projectRevision: raw.projectRevision,
        wallets: raw.candidates,
      });
      if (!current()) return;
      setSource(parsed);
      onChange({ ...parsed, wallets: [] });
    } catch (caught) {
      if (!current()) return;
      setSource(null);
      setSelected([]);
      setError(
        caught instanceof Error &&
          [
            'Sign in to choose saved wallet assignments.',
            'Saved project assignments are unavailable.',
          ].includes(caught.message)
          ? caught.message
          : 'Wallet assignments unavailable. Load them again before selecting any.',
      );
    } finally {
      if (current()) setLoading(false);
    }
  }

  return (
    <details className={styles.picker}>
      <summary>Choose read-only wallet assignment references</summary>
      <p id={`${id}-scope`}>
        New invites disclose no wallet assignments by default. You can select
        saved public assignment references below. This never grants wallet
        control, trading, signing or transfer permissions.
      </p>
      <p>
        New wallets and later revisions are never added automatically. The
        shared plan text and summary remain visible. Revoking access stops
        future reads but cannot erase information already copied.
      </p>
      <Button
        type="button"
        variant="outline"
        className={styles.load}
        disabled={busy || loading}
        onClick={() => void load()}
      >
        Load saved wallet assignments
      </Button>
      {loading && <output>Loading saved wallet assignments…</output>}
      {error && <p role="alert">{error}</p>}
      {source && (
        <>
          <p>
            Saved project revision:{' '}
            <time dateTime={source.projectRevision}>
              {new Date(source.projectRevision).toLocaleString()}
            </time>
            . Loading again clears this selection.
          </p>
          {source.wallets.length === 0 ? (
            <p>No wallet assignments are saved in this project.</p>
          ) : (
            <fieldset
              className={styles.assignments}
              disabled={busy || loading}
              aria-describedby={`${id}-scope`}
            >
              <legend>Public references to disclose</legend>
              {source.wallets.map((wallet) => {
                const key = keyFor(wallet);
                return (
                  <label key={key} className={styles.wallet}>
                    <input
                      type="checkbox"
                      checked={selected.includes(key)}
                      onChange={(event) => {
                        if (busy || loading) return;
                        const next = event.target.checked
                          ? [...selected, key]
                          : selected.filter((value) => value !== key);
                        setSelected(next);
                        onChange(
                          readProjectShareScope({
                            ...source,
                            wallets: source.wallets.filter((entry) =>
                              next.includes(keyFor(entry)),
                            ),
                          }),
                        );
                      }}
                    />
                    <span>
                      {wallet.role} · {wallet.chain} · revision{' '}
                      {wallet.revision}
                      <code>{wallet.address}</code>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <output aria-live="polite">
            {selected.length} saved assignment reference
            {selected.length === 1 ? '' : 's'} selected for the next invite.
          </output>
        </>
      )}
    </details>
  );
}
