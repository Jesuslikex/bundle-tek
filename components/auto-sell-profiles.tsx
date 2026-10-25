'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { AutoSellStrategySummary } from './auto-sell-strategy-summary';
import { autoSellMaximumLabel, formatDuration } from '@/lib/auto-sell';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { AutoSellConfiguration } from '@/lib/auto-sell-edit';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  autoSellProfileId,
  autoSellProfileSha256,
  autoSellProfileTermsJson,
  readSavedAutoSellProfile,
  requireAutoSellProfileSummary,
  requireAutoSellProfileTerms,
  type AutoSellProfileSummary,
  type SavedAutoSellProfile,
} from '@/lib/auto-sell-profile';
import styles from './auto-sell-profiles.module.css';

type Props = {
  project: ImportedTokenProject;
  wallets: WorkspaceWallet[];
  selectedWallets: string[];
  configuration: AutoSellConfiguration;
  disabled: boolean;
  saveBlockedReason?: string;
  draftContext?: string;
  onRestore: (profile: SavedAutoSellProfile, wallets: string[]) => void;
};
type Reminder = {
  id: string;
  profileId: string;
  expectedVersion: number;
  sha256: string;
};
const endpoint = '/api/imported-projects/auto-sell-profiles';
const storageKey = (id: string) => `bundle:auto-sell-profile-save:v1:${id}`;
const unavailable =
  'Saved configurations are unavailable. Load history to try again.';
function reminder(value: unknown): Reminder {
  const r = value as Reminder;
  if (
    !r ||
    typeof r !== 'object' ||
    Object.keys(r).sort().join(',') !== 'expectedVersion,id,profileId,sha256' ||
    !Number.isSafeInteger(r.expectedVersion) ||
    r.expectedVersion < 0 ||
    r.expectedVersion >= 1000 ||
    typeof r.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.sha256)
  )
    throw Error('Invalid reminder.');
  return {
    id: autoSellProfileId(r.id),
    profileId: autoSellProfileId(r.profileId),
    expectedVersion: r.expectedVersion,
    sha256: r.sha256,
  };
}
function readReminder(id: string): Reminder | null {
  try {
    const text = localStorage.getItem(storageKey(id));
    return text ? reminder(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}
function authority(value: unknown): Record<string, unknown> {
  const r = value as Record<string, unknown>;
  if (
    !r ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    r.signingAllowed !== false ||
    r.executionAllowed !== false ||
    r.automaticResumeAllowed !== false
  )
    throw Error(unavailable);
  return r;
}
async function request(url: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Error(
      response.status === 401
        ? 'Sign in again to access saved configurations.'
        : response.status === 404
          ? 'This saved version is not currently available. A missing save is not proof it cannot still finish.'
          : response.status === 409
            ? 'The project, wallets or profile version changed, or storage is full. Reload history before another save.'
            : unavailable,
    );
  }
  return authority(await readBoundedPanelJson(response, signal));
}
async function profileResponse(
  value: Record<string, unknown>,
  projectId: string,
  id?: string,
) {
  if (
    Object.keys(value).sort().join(',') !==
    'automaticResumeAllowed,executionAllowed,profile,signingAllowed'
  )
    throw Error(unavailable);
  const profile = await readSavedAutoSellProfile(value.profile);
  if (profile.terms.projectId !== projectId || (id && profile.id !== id))
    throw Error('Saved configuration context differs.');
  return profile;
}

/** A changed configuration/roster resets inspection and its unchecked acknowledgement. */
export function AutoSellProfiles(props: Props) {
  const key = JSON.stringify([
    props.project.id,
    props.project.revision,
    props.project.archived,
    props.project.document.token,
    props.wallets.map((w) => [w.chain, w.address, w.revision, w.archived]),
    props.selectedWallets,
    props.configuration,
    props.disabled,
    props.saveBlockedReason,
    props.draftContext,
  ]);
  return <ProfilePanel key={key} {...props} />;
}
function ProfilePanel({
  project,
  wallets,
  selectedWallets,
  configuration,
  disabled,
  saveBlockedReason = '',
  onRestore,
}: Props) {
  const [name, setName] = useState('Auto Sell configuration');
  const [page, setPage] = useState<AutoSellProfileSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<SavedAutoSellProfile | null>(null);
  const [approved, setApproved] = useState(false);
  const [pendingSave, setPendingSave] = useState<Reminder | null>(null);
  const [reminderReady, setReminderReady] = useState(false);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) {
        setPendingSave(readReminder(project.id));
        setReminderReady(true);
      }
    });
    return () => {
      alive = false;
      pending.current?.abort();
    };
  }, [project.id]);
  const token = project.document.token;
  async function run(
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    const current = () => !signal.aborted && pending.current === controller;
    setBusy(true);
    setError('');
    setNotice('');
    setApproved(false);
    try {
      await work(signal, current);
    } catch (e) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          signal.aborted
            ? 'Request interrupted. Check the original save outcome before saving again.'
            : e instanceof Error
              ? e.message
              : unavailable,
        );
    } finally {
      if (pending.current === controller && !controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function forget() {
    try {
      localStorage.removeItem(storageKey(project.id));
    } catch {
      /* The visible reminder remains manually inspectable. */
    }
    setPendingSave(null);
  }
  function remember(value: Reminder) {
    setPendingSave(value);
    try {
      localStorage.setItem(storageKey(project.id), JSON.stringify(value));
    } catch {
      setNotice(
        'Browser storage cannot retain this reminder. Keep the save ID shown here and inspect history after a reload.',
      );
    }
  }
  function terms() {
    if (saveBlockedReason) throw Error(saveBlockedReason);
    if (!name.trim()) throw Error('Choose a configuration name before saving.');
    if (!selectedWallets.length)
      throw Error('Choose current sell wallets before saving a configuration.');
    return requireAutoSellProfileTerms({
      name,
      projectId: project.id,
      projectRevision: project.revision,
      token: {
        chain: token.chain,
        mint: token.address,
        decimals: token.decimals,
        totalSupplyRaw: token.totalSupplyRaw,
      },
      wallets: selectedWallets.map((address) => {
        const wallet = wallets.find(
          (w) => w.chain === 'Solana' && !w.archived && w.address === address,
        );
        if (!wallet)
          throw Error('Choose current active sell wallets before saving.');
        return { address, revision: wallet.revision };
      }),
      configuration,
    });
  }
  async function load(
    signal: AbortSignal,
    current: () => boolean,
    before: string | null = null,
  ) {
    const params = new URLSearchParams({ projectId: project.id });
    if (before) params.set('before', before);
    const value = await request(endpoint + '?' + params, signal);
    if (
      Object.keys(value).sort().join(',') !==
        'automaticResumeAllowed,executionAllowed,nextCursor,profiles,signingAllowed' ||
      !Array.isArray(value.profiles) ||
      value.profiles.length > 20 ||
      !(value.nextCursor === null || typeof value.nextCursor === 'string')
    )
      throw Error(unavailable);
    const profiles = value.profiles.map(requireAutoSellProfileSummary);
    if (
      new Set(profiles.map((p) => p.id)).size !== profiles.length ||
      (value.nextCursor !== null &&
        (!profiles.length ||
          autoSellProfileId(value.nextCursor) !== profiles.at(-1)!.id))
    )
      throw Error(unavailable);
    if (!current()) return;
    setPage(profiles);
    setNext(value.nextCursor);
    setLoaded(true);
    setSelected(null);
  }
  async function open(
    signal: AbortSignal,
    current: () => boolean,
    row: AutoSellProfileSummary,
  ) {
    const value = await request(
      endpoint +
        '?' +
        new URLSearchParams({ projectId: project.id, id: row.id }),
      signal,
    );
    const profile = await profileResponse(value, project.id, row.id);
    if (
      profile.profileId !== row.profileId ||
      profile.version !== row.version ||
      profile.sha256 !== row.sha256
    )
      throw Error(
        'Saved version differs from its history index. Reload history.',
      );
    if (current()) setSelected(profile);
  }
  async function save(
    signal: AbortSignal,
    current: () => boolean,
    original: SavedAutoSellProfile | null,
  ) {
    const input = terms(),
      sha256 = await autoSellProfileSha256(autoSellProfileTermsJson(input));
    signal.throwIfAborted();
    if (!current()) return;
    const identity = {
      id: crypto.randomUUID(),
      profileId: original?.profileId ?? crypto.randomUUID(),
      expectedVersion: original?.version ?? 0,
      sha256,
    };
    remember(identity);
    const value = await request(endpoint, signal, {
      action: 'save',
      id: identity.id,
      profileId: identity.profileId,
      expectedVersion: identity.expectedVersion,
      terms: input,
    });
    const profile = await profileResponse(value, project.id, identity.id);
    if (
      profile.profileId !== identity.profileId ||
      profile.version !== identity.expectedVersion + 1 ||
      profile.sha256 !== sha256 ||
      autoSellProfileTermsJson(profile.terms) !==
        autoSellProfileTermsJson(input)
    )
      throw Error('Saved terms differ. Check the original save ID.');
    if (!current()) return;
    forget();
    setSelected(profile);
    setNotice('Configuration saved. This does not start or approve a run.');
  }
  async function recover(
    signal: AbortSignal,
    current: () => boolean,
    identity: Reminder,
  ) {
    const profile = await profileResponse(
      await request(
        endpoint +
          '?' +
          new URLSearchParams({ projectId: project.id, id: identity.id }),
        signal,
      ),
      project.id,
      identity.id,
    );
    if (
      profile.profileId !== identity.profileId ||
      profile.version !== identity.expectedVersion + 1 ||
      profile.sha256 !== identity.sha256
    )
      throw Error(
        'Original save reference differs. Keep the original ID for inspection.',
      );
    if (!current()) return;
    forget();
    setSelected(profile);
    setNotice(
      'Original save found. Review these retained settings before using them.',
    );
  }
  const matchingIdentity =
    selected &&
    selected.terms.token.chain === token.chain &&
    selected.terms.token.mint === token.address &&
    selected.terms.token.decimals === token.decimals &&
    selected.terms.token.totalSupplyRaw === token.totalSupplyRaw;
  const matchingWallets =
    selected?.terms.wallets.every((saved) =>
      wallets.some(
        (w) =>
          w.chain === 'Solana' &&
          !w.archived &&
          w.address === saved.address &&
          w.revision === saved.revision,
      ),
    ) ?? false;
  return (
    <details className={styles.panel}>
      <summary>Saved Auto Sell configurations</summary>
      <p>
        Save settings for a new reviewed run. Profiles do not retain passwords,
        approvals, processed orders, spent budgets or a running session.
        Reloading never resumes Auto Sell.
      </p>
      <p>
        Changing settings or wallet context closes the saved review and clears
        its acknowledgement.
      </p>
      <label>
        Configuration name
        <input
          value={name}
          maxLength={80}
          disabled={busy || disabled}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <Button
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void run((signal, current) => load(signal, current))}
        >
          Load saved history
        </Button>
        <Button
          disabled={
            !reminderReady ||
            !!saveBlockedReason ||
            busy ||
            disabled ||
            project.archived ||
            !!pendingSave
          }
          onClick={() =>
            void run((signal, current) => save(signal, current, null))
          }
        >
          Save current settings as new profile
        </Button>
        {selected && (
          <Button
            variant="outline"
            disabled={
              !reminderReady ||
              !!saveBlockedReason ||
              busy ||
              disabled ||
              project.archived ||
              !!pendingSave
            }
            onClick={() =>
              void run((signal, current) => save(signal, current, selected))
            }
          >
            Save current settings as version {selected.version + 1}
          </Button>
        )}
      </div>
      {saveBlockedReason && (
        <p>
          Complete the current settings before saving: {saveBlockedReason} Saved
          history and restoration remain available.
        </p>
      )}
      <p>
        Up to 100 profiles and 1,000 retained versions per token project. Each
        profile has a 262144-byte capacity. Saves are immutable; newer versions
        do not rewrite older settings.
      </p>
      {pendingSave && (
        <section aria-label="Original profile save recovery">
          <p>
            Original save ID: <code>{pendingSave.id}</code>. A timeout is not
            proof the save failed.
          </p>
          <Button
            variant="outline"
            disabled={busy || disabled}
            onClick={() => void run((s, c) => recover(s, c, pendingSave))}
          >
            Check original save outcome
          </Button>
          <Button
            variant="outline"
            disabled={busy || disabled}
            onClick={() => {
              forget();
              setNotice(
                'Local reminder dismissed only. The original save may still appear in history; inspect it before saving another copy.',
              );
            }}
          >
            Dismiss local save reminder
          </Button>
        </section>
      )}
      {loaded && (
        <section aria-label="Saved configuration history">
          <p>Saved index only. Open a version to verify its full settings.</p>
          {page.length === 0 ? (
            <p>No saved versions in this history page.</p>
          ) : (
            <ul>
              {page.map((row) => (
                <li key={row.id}>
                  <strong>{row.name}</strong> · version {row.version} · project
                  revision {row.projectRevision} · {row.strategyCount}{' '}
                  strategies · {row.walletCount} wallets{' '}
                  <time dateTime={row.createdAt}>
                    {new Date(row.createdAt).toLocaleString()}
                  </time>
                  <Button
                    variant="outline"
                    disabled={busy || disabled}
                    onClick={() => void run((s, c) => open(s, c, row))}
                  >
                    Open version {row.version} · {row.id}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {next && (
            <Button
              variant="outline"
              disabled={busy || disabled}
              onClick={() => void run((s, c) => load(s, c, next))}
            >
              Older saved versions
            </Button>
          )}
        </section>
      )}
      {selected && (
        <section aria-label="Saved configuration review">
          <h4>
            {selected.terms.name} · version {selected.version}
          </h4>
          <p>
            Saved project revision {selected.terms.projectRevision}; current
            revision {project.revision}. Mint {selected.terms.token.mint}. Hash{' '}
            <code>{selected.sha256}</code>.
          </p>
          {selected.terms.configuration.session.maxSlippageBps ===
            undefined && (
            <p>
              No slippage ceiling was stored. Restoring uses the existing
              default of 50 bps (0.5%); review it before a new Run.
            </p>
          )}
          <dl className={styles.settings}>
            <dt>Saved start delay</dt>
            <dd>
              {selected.terms.configuration.session.startDelaySeconds
                ? formatDuration(
                    selected.terms.configuration.session.startDelaySeconds,
                  )
                : 'No delay'}
            </dd>
            <dt>Saved session duration</dt>
            <dd>
              {selected.terms.configuration.session.endDurationSeconds
                ? formatDuration(
                    selected.terms.configuration.session.endDurationSeconds,
                  )
                : 'No duration end set'}
            </dd>
            <dt>Saved session maximum</dt>
            <dd>
              {autoSellMaximumLabel(selected.terms.configuration.session)}
            </dd>
            <dt>Saved slippage ceiling</dt>
            <dd>
              {selected.terms.configuration.session.maxSlippageBps ??
                'Default 50'}{' '}
              bps
            </dd>
          </dl>
          {selected.terms.configuration.strategies.map((strategy) => (
            <article key={strategy.id}>
              <h5>{strategy.name}</h5>
              <AutoSellStrategySummary strategy={strategy} />
              <p>
                Saved market-cap range: ${strategy.marketCapMinUsd || '0'} to{' '}
                {strategy.marketCapMaxUsd
                  ? '$' + strategy.marketCapMaxUsd
                  : 'no upper bound'}
                . Maximum: {autoSellMaximumLabel(strategy)}. Duration:{' '}
                {strategy.endDurationSeconds
                  ? formatDuration(strategy.endDurationSeconds)
                  : 'no duration end set'}
                . {strategy.whitelist.length} ignored wallets.
              </p>
              {strategy.mode === 'counter' && (
                <p>
                  Saved minimum supply per sell:{' '}
                  {strategy.minSupplyPercentPerSell || '0'}%.
                </p>
              )}
              {strategy.mode === 'limit' && (
                <ol>
                  {strategy.limitOrders.map((row) => (
                    <li key={row.id}>
                      {row.amount}
                      {strategy.amountUnit === 'supply'
                        ? '% of supply'
                        : ' tokens'}{' '}
                      at ${row.marketCapUsd} market cap.
                    </li>
                  ))}
                </ol>
              )}
            </article>
          ))}
          <p>
            {matchingIdentity
              ? 'Token identity and units match the current project.'
              : 'Token identity, decimals or supply differ. These settings cannot be restored into this context.'}
          </p>
          <p>
            {matchingWallets
              ? 'Saved wallet revisions match the current roster.'
              : 'Saved wallets changed or are missing. Restoring settings will clear wallet selection; select current wallets again.'}
          </p>
          <details>
            <summary>Exact saved settings and wallet revisions</summary>
            <pre>
              {JSON.stringify(
                {
                  wallets: selected.terms.wallets,
                  configuration: selected.terms.configuration,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={approved}
              disabled={
                busy || disabled || !matchingIdentity || project.archived
              }
              onChange={(e) => setApproved(e.target.checked)}
            />
            I reviewed this saved configuration for a new run. This does not
            resume or approve execution.
          </label>
          <Button
            disabled={
              !approved ||
              busy ||
              disabled ||
              !matchingIdentity ||
              project.archived
            }
            onClick={() => {
              setApproved(false);
              onRestore(
                selected,
                matchingWallets
                  ? selected.terms.wallets.map((w) => w.address)
                  : [],
              );
            }}
          >
            Use settings for a new reviewed run
          </Button>
        </section>
      )}
      {busy && <output>Reading or saving configuration…</output>}
      {error && <p role="alert">{error}</p>}
      {error === 'Sign in again to access saved configurations.' && (
        <p>
          <a href="/sign-in" target="_blank" rel="noopener noreferrer">
            Sign in in a separate tab
          </a>
          . Return here and manually reload history or check the original save
          outcome. Nothing resumes automatically.
        </p>
      )}
      {notice && <output>{notice}</output>}
    </details>
  );
}
