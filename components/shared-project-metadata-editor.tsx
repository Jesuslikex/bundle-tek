'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { projectIdValid } from '@/lib/workspace-project';
import {
  metadataEditReviewHash,
  normalizeMetadataText,
  readMetadataEditSource,
  verifyMetadataEditReceipt,
  type MetadataEditReceipt,
  type MetadataEditSource,
  type MetadataText,
} from '@/lib/project-collaboration-metadata';
import styles from './shared-project-metadata-editor.module.css';

type Props = {
  projectId: string;
  shareId: string;
  projectUpdatedAt: string;
  locked?: boolean;
};
type EditorProps = Props & { recoveryOnly?: boolean };
type Reminder = {
  mutationId: string;
  shareId: string;
  projectId: string;
  reviewHash: string;
};
type Review = {
  source: MetadataEditSource;
  values: MetadataText;
  hash: string;
  version: number;
};
const endpoint = '/api/projects/collaboration/metadata';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyFor = (shareId: string, projectId: string) =>
  `bundle-shared-metadata-edit:${shareId}:${projectId}`;
function readReminder(text: string, props: Props): Reminder {
  let value: Reminder;
  try {
    if (text.length > 1024) throw Error('Invalid reminder');
    value = JSON.parse(text) as Reminder;
  } catch {
    throw Error(
      'The original edit reminder cannot be read. Keep it and ask the owner to revoke this invite before starting another edit.',
    );
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'mutationId,projectId,reviewHash,shareId' ||
    typeof value.mutationId !== 'string' ||
    !uuid.test(value.mutationId) ||
    value.shareId !== props.shareId ||
    value.projectId !== props.projectId ||
    typeof value.reviewHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.reviewHash)
  )
    throw Error(
      'The original edit reminder cannot be read. Keep it and ask the owner to revoke this invite before starting another edit.',
    );
  return {
    mutationId: value.mutationId,
    shareId: value.shareId,
    projectId: value.projectId,
    reviewHash: value.reviewHash,
  };
}
function initialReminder(props: Props) {
  try {
    const text = localStorage.getItem(keyFor(props.shareId, props.projectId));
    return {
      reminder: text === null ? null : readReminder(text, props),
      error: '',
    };
  } catch (error) {
    return {
      reminder: null,
      error:
        error instanceof Error
          ? error.message
          : 'Recovery storage is unavailable. No edit can be sent.',
    };
  }
}
async function readResponse(response: Response, signal: AbortSignal) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Error(
      response.status === 401
        ? 'Sign in again before checking this saved-text edit.'
        : response.status === 403 || response.status === 404
          ? 'This edit permission or saved record is unavailable. It may have expired or been revoked. A missing edit is not proof it cannot still finish.'
          : response.status === 409
            ? 'The saved project or permission changed. Check the original edit before another save.'
            : 'The saved-text response is unavailable. Check the original edit before repeating a save.',
    );
  }
  return readBoundedPanelJson(response, signal);
}

/** The parent exposes this only for an explicit server-reported text permission.
 * Every request is still authorized independently by the server. */
export function SharedProjectMetadataEditor(props: Props) {
  return (
    <MetadataEditor
      key={JSON.stringify([
        props.projectId,
        props.shareId,
        props.projectUpdatedAt,
        props.locked === true,
      ])}
      {...props}
    />
  );
}

/** Retained IDs can outlive an expired or revoked accepted share. They confer
 * no current project authority; the server admits only the actor's own receipt. */
export function SharedProjectMetadataRecovery({
  activeShareIds,
}: {
  activeShareIds: string[];
}) {
  const [entries, setEntries] = useState<Reminder[]>([]);
  const [scanError, setScanError] = useState('');
  const active = JSON.stringify([...new Set(activeShareIds)].sort());
  const refresh = useCallback(() => {
    const excluded = new Set(JSON.parse(active) as string[]);
    const next: Reminder[] = [];
    let invalid = false;
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith('bundle-shared-metadata-edit:')) continue;
        const parts = key.split(':');
        if (
          parts.length !== 3 ||
          !uuid.test(parts[1]) ||
          !projectIdValid(parts[2])
        ) {
          invalid = true;
          continue;
        }
        const [, shareId, projectId] = parts;
        if (excluded.has(shareId)) continue;
        const text = localStorage.getItem(key);
        if (text === null) continue;
        try {
          next.push(
            readReminder(text, { shareId, projectId, projectUpdatedAt: '' }),
          );
        } catch {
          invalid = true;
        }
      }
      setEntries(
        next.sort((left, right) =>
          keyFor(left.shareId, left.projectId).localeCompare(
            keyFor(right.shareId, right.projectId),
          ),
        ),
      );
      setScanError(
        invalid
          ? 'Some retained edit IDs cannot be read. They have not been removed. Ask the owner to revoke the old invite before a new edit.'
          : '',
      );
    } catch {
      setScanError(
        'Local edit recovery storage is unavailable. No original edit has been cleared or repeated.',
      );
    }
  }, [active]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) refresh();
    });
    return () => {
      mounted = false;
    };
  }, [refresh]);
  if (entries.length === 0 && !scanError) return null;
  return (
    <section
      className={styles.editor}
      aria-label="Past shared-project edit recovery"
    >
      <h4>Past shared-project edits</h4>
      <p className={styles.note}>
        These local IDs may belong to an expired or revoked invite. Check only
        the original saved-text receipt. This does not restore project access or
        send the edit again.
      </p>
      <Button type="button" onClick={refresh}>
        Refresh local edit IDs
      </Button>
      {scanError && <p role="alert">{scanError}</p>}
      {entries.map((entry) => (
        <div key={keyFor(entry.shareId, entry.projectId)}>
          <p className={styles.note}>
            Share ID: <code>{entry.shareId}</code>
            <br />
            Project ID: <code>{entry.projectId}</code>
          </p>
          <MetadataEditor
            key={JSON.stringify(entry)}
            projectId={entry.projectId}
            shareId={entry.shareId}
            projectUpdatedAt=""
            locked
            recoveryOnly
          />
        </div>
      ))}
    </section>
  );
}

function MetadataEditor(props: EditorProps) {
  const id = useId();
  const storageKey = keyFor(props.shareId, props.projectId);
  const [initial] = useState(() => initialReminder(props));
  const [reminder, setReminder] = useState<Reminder | null>(initial.reminder);
  const [storageError, setStorageError] = useState(initial.error);
  const [source, setSource] = useState<MetadataEditSource | null>(null);
  const [draft, setDraft] = useState<MetadataText>({
    tokenName: '',
    ticker: '',
    description: '',
  });
  const [review, setReview] = useState<Review | null>(null);
  const [approved, setApproved] = useState(false);
  const [receipt, setReceipt] = useState<MetadataEditReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false),
    running = useRef(false),
    version = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const held = reminder !== null || storageError !== '';

  const stop = useCallback(() => {
    alive.current = false;
    version.current++;
    pending.current?.abort();
  }, []);
  useEffect(() => {
    alive.current = true;
    return stop;
  }, [stop]);

  async function task(
    action: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    const operation = version.current;
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    const current = () =>
      alive.current && version.current === operation && !signal.aborted;
    try {
      await action(signal, current);
    } catch (error) {
      if (alive.current && version.current === operation)
        setError(
          error instanceof Error
            ? error.message
            : 'Saved-text editing is unavailable.',
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (alive.current) setBusy(false);
      running.current = false;
    }
  }

  function change(field: keyof MetadataText, value: string) {
    version.current++;
    setDraft((old) => ({ ...old, [field]: value }));
    setReview(null);
    setApproved(false);
    setError('');
  }

  async function load(signal: AbortSignal, current: () => boolean) {
    if (held || props.locked || props.recoveryOnly) return;
    setReview(null);
    setApproved(false);
    setReceipt(null);
    const response = await fetch(
      `${endpoint}?shareId=${encodeURIComponent(props.shareId)}`,
      { cache: 'no-store', signal },
    );
    const value = readMetadataEditSource(await readResponse(response, signal));
    if (!current()) return;
    if (
      value.shareId !== props.shareId ||
      value.projectId !== props.projectId ||
      value.projectUpdatedAt !== props.projectUpdatedAt
    )
      throw Error(
        'The shared project changed. Refresh shared projects before loading its saved text.',
      );
    setSource(value);
    setDraft(value.values);
  }

  async function inspect(_signal: AbortSignal, current: () => boolean) {
    if (!source || held || props.locked || props.recoveryOnly) return;
    setReview(null);
    setApproved(false);
    const values = normalizeMetadataText(draft);
    if (JSON.stringify(values) === JSON.stringify(source.values))
      throw Error('Change the saved text before reviewing an edit.');
    const hash = await metadataEditReviewHash(source, values);
    if (current())
      setReview({ source, values, hash, version: version.current });
  }

  async function admitReceipt(
    value: unknown,
    captured: Reminder,
    current: () => boolean,
  ) {
    const result = await verifyMetadataEditReceipt(value);
    if (!current()) return;
    if (
      result.mutationId !== captured.mutationId ||
      result.shareId !== captured.shareId ||
      result.projectId !== captured.projectId ||
      result.reviewHash !== captured.reviewHash
    )
      throw Error(
        'The saved edit receipt differs from the original request. Keep its ID and check it again.',
      );
    setReceipt(result);
    setSource(null);
    setReview(null);
    setApproved(false);
    const expected = JSON.stringify(captured);
    try {
      const retained = localStorage.getItem(storageKey);
      if (retained !== expected) {
        if (retained !== null) setReminder(readReminder(retained, props));
        throw Error(
          'Another tab changed the recovery reminder. Keep this receipt and check the retained original edit.',
        );
      }
      localStorage.removeItem(storageKey);
      if (localStorage.getItem(storageKey) !== null)
        throw Error('The completed edit reminder could not be cleared.');
      setReminder(null);
      setStorageError('');
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : 'Recovery storage is unavailable. Keep the saved receipt.',
      );
    }
  }

  async function save(signal: AbortSignal, current: () => boolean) {
    if (
      !source ||
      !review ||
      !approved ||
      held ||
      props.locked ||
      props.recoveryOnly ||
      review.version !== version.current
    )
      return;
    const captured: Reminder = {
      mutationId: crypto.randomUUID(),
      shareId: props.shareId,
      projectId: props.projectId,
      reviewHash: review.hash,
    };
    const text = JSON.stringify(captured);
    try {
      const existing = localStorage.getItem(storageKey);
      if (existing !== null) {
        setReminder(readReminder(existing, props));
        throw Error(
          'An original edit still needs checking. No new save was sent.',
        );
      }
      localStorage.setItem(storageKey, text);
      if (localStorage.getItem(storageKey) !== text)
        throw Error('The edit ID could not be retained. No new save was sent.');
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : 'The edit ID could not be retained. No new save was sent.',
      );
      return;
    }
    setReminder(captured);
    setApproved(false);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal,
      body: JSON.stringify({
        action: 'save',
        ...captured,
        expectedUpdatedAt: review.source.projectUpdatedAt,
        values: review.values,
        approved: true,
      }),
    });
    await admitReceipt(await readResponse(response, signal), captured, current);
  }

  async function recover(signal: AbortSignal, current: () => boolean) {
    if (!reminder) return;
    const response = await fetch(
      `${endpoint}?mutationId=${encodeURIComponent(reminder.mutationId)}`,
      { cache: 'no-store', signal },
    );
    const value = (await readResponse(response, signal)) as {
      receipt?: unknown;
    } | null;
    if (!current()) return;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).join(',') !== 'receipt'
    )
      throw Error(
        'The original edit response is unavailable. Keep its ID and check again.',
      );
    if (value.receipt === null)
      throw Error(
        'No receipt is recorded yet. The original request may still finish. Do not repeat it; check again or ask the owner to revoke this invite before starting another edit.',
      );
    await admitReceipt(value.receipt, reminder, current);
  }

  return (
    <details className={styles.editor}>
      <summary>
        {props.recoveryOnly
          ? 'Check past saved-text edit'
          : 'Edit saved project text'}
      </summary>
      <p className={styles.note}>
        {props.recoveryOnly
          ? 'This checks only a retained app edit receipt. An old receipt does not restore current project or editing access. It grants no wallet, trading, publication or signing access.'
          : 'This permission covers only the saved name, symbol and description. It changes no on-chain token and grants no wallet, trading, publication or signing access. The owner must publish changed metadata before a fresh launch review.'}
      </p>
      {storageError && <p role="alert">{storageError}</p>}
      {reminder && (
        <div className={styles.pending}>
          <p>
            An original saved-text edit needs checking. No new save can be sent.
          </p>
          <p>
            Edit ID: <code>{reminder.mutationId}</code>
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void task(recover)}
          >
            Check original edit
          </Button>
        </div>
      )}
      {!props.recoveryOnly && (
        <Button
          type="button"
          disabled={busy || props.locked || held}
          onClick={() => void task(load)}
        >
          Load current saved text
        </Button>
      )}
      {!props.recoveryOnly && source && (
        <>
          <p className={styles.note}>
            Saved revision:{' '}
            <time dateTime={source.projectUpdatedAt}>
              {source.projectUpdatedAt}
            </time>
            . Editing permission is rechecked by the server on save.
          </p>
          <div className={styles.fields}>
            <label htmlFor={`${id}-name`}>
              Saved project name
              <input
                id={`${id}-name`}
                value={draft.tokenName}
                maxLength={64}
                disabled={busy || props.locked || held}
                onChange={(event) => change('tokenName', event.target.value)}
              />
            </label>
            <label htmlFor={`${id}-ticker`}>
              Saved symbol
              <input
                id={`${id}-ticker`}
                value={draft.ticker}
                maxLength={16}
                disabled={busy || props.locked || held}
                onChange={(event) => change('ticker', event.target.value)}
              />
            </label>
            <label htmlFor={`${id}-description`}>
              Saved description
              <textarea
                id={`${id}-description`}
                value={draft.description}
                maxLength={280}
                disabled={busy || props.locked || held}
                onChange={(event) => change('description', event.target.value)}
              />
            </label>
          </div>
          <Button
            type="button"
            disabled={busy || props.locked || held}
            onClick={() => void task(inspect)}
          >
            Review text changes
          </Button>
        </>
      )}
      {!props.recoveryOnly && review && (
        <section
          className={styles.review}
          aria-label="Review saved-text changes"
        >
          <h4>Review exact saved-text changes</h4>
          <p className={styles.note}>
            Names and descriptions are trimmed; symbols are trimmed and
            uppercase. These are the exact values proposed for saving.
          </p>
          {(['tokenName', 'ticker', 'description'] as const).map((field) => (
            <div key={field} className={styles.comparison}>
              <strong>
                {
                  {
                    tokenName: 'Name',
                    ticker: 'Symbol',
                    description: 'Description',
                  }[field]
                }
              </strong>
              <p>
                Before: <span>{review.source.values[field] || '(empty)'}</span>
              </p>
              <p>
                After: <span>{review.values[field] || '(empty)'}</span>
              </p>
            </div>
          ))}
          <label className={styles.approval}>
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || props.locked || held}
              onChange={(event) => setApproved(event.target.checked)}
            />
            I approve these exact saved-text changes
          </label>
          <Button
            type="button"
            disabled={busy || props.locked || held || !approved}
            onClick={() => void task(save)}
          >
            Save reviewed text once
          </Button>
        </section>
      )}
      {receipt && (
        <section
          className={styles.receipt}
          aria-label="Saved text edit receipt"
        >
          <h4>Saved text edit recorded</h4>
          <p>
            Retained edit ID: <code>{receipt.mutationId}</code>
          </p>
          <p>
            Previous revision:{' '}
            <time dateTime={receipt.beforeUpdatedAt}>
              {receipt.beforeUpdatedAt}
            </time>
          </p>
          <p>
            Saved revision:{' '}
            <time dateTime={receipt.updatedAt}>{receipt.updatedAt}</time>
          </p>
          {(['tokenName', 'ticker', 'description'] as const).map((field) => (
            <div key={field} className={styles.comparison}>
              <strong>
                {
                  {
                    tokenName: 'Name',
                    ticker: 'Symbol',
                    description: 'Description',
                  }[field]
                }
              </strong>
              <p>Previous value: {receipt.before[field] || '(empty)'}</p>
              <p>Saved value: {receipt.after[field] || '(empty)'}</p>
            </div>
          ))}
          <p className={styles.note}>
            This receipt records this app edit only. Refresh shared projects for
            the current saved state; the owner still controls publication and
            launch approval.
          </p>
        </section>
      )}
      {busy && <output>Checking saved text…</output>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
