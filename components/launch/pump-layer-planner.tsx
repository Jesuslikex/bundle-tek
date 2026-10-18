'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  initialLayerDraft,
  layerDisplay,
  layerAmount,
  layerQuote,
  layerRequest,
  newLayerRow,
  parseLayerContext,
  parseSavedLayer,
  reviewLayerDraft,
  reopenLayerDraft,
  type LayerDraft,
  type LayerPlanningContext,
  type LayerRole,
  type LayerSelection,
} from '@/lib/launch-layer-client';
import type { LaunchLayerEnvelope } from '@/lib/launch-layer-terms';
import styles from './pump-layer-planner.module.css';

const endpoint = '/api/launch/layers';
const names: Record<LayerRole, string> = {
  funder: 'Funder',
  developer: 'Developer',
  front: 'Front buyer',
  back: 'Back buyer',
  temporary: 'Temporary holder',
  holders: 'Final holder',
};
type Saved = ReturnType<typeof parseSavedLayer>;
type Review = { envelope: LaunchLayerEnvelope; draft: LayerDraft };
async function read(response: Response) {
  let value: Record<string, unknown>;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      'Planning service did not return a readable response. Retry loading the plan.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'Planning service returned an incomplete response. Reload layer history before retrying.',
    );
  if (!response.ok) {
    const message =
      typeof value?.error === 'string' &&
      value.error.length <= 500 &&
      !/[<>]/.test(value.error)
        ? value.error
        : 'Layer planning is unavailable. Reload the saved plan before retrying.';
    throw new Error(message);
  }
  return value;
}
function BudgetReview({ envelope }: { envelope: LaunchLayerEnvelope }) {
  const { quote, totals, delays, roles } = envelope.terms;
  return (
    <section className={styles.review} aria-label="Layer budget review">
      <h4>Declared ceiling review</h4>
      <p>
        These are your maximum planning amounts. They are not verified costs,
        current balances or funding requirements.
      </p>
      <dl className={styles.totals}>
        <div>
          <dt>Total buy ceiling ({quote.symbol})</dt>
          <dd>{layerDisplay(totals.maximumBuyQuoteRaw, quote.decimals)}</dd>
        </div>
        <div>
          <dt>Network fee ceilings (SOL)</dt>
          <dd>{layerDisplay(totals.maximumNetworkFeeLamports, 9)}</dd>
        </div>
        <div>
          <dt>Account rent ceilings (SOL)</dt>
          <dd>{layerDisplay(totals.maximumAccountRentLamports, 9)}</dd>
        </div>
        <div>
          <dt>Retained reserves (SOL)</dt>
          <dd>{layerDisplay(totals.retainedNativeReserveLamports, 9)}</dd>
        </div>
        <div>
          <dt>Total native ceiling (SOL)</dt>
          <dd>{layerDisplay(totals.maximumNativeBudgetLamports, 9)}</dd>
        </div>
      </dl>
      <p>
        {quote.kind === 'native'
          ? 'The native total includes SOL buys, fees, rent and reserves.'
          : `${quote.symbol} buys are separate from the SOL total. Units use the saved quote catalog; live mint scaling is not verified.`}
      </p>
      <p>
        Funding delay: {delays.fundingDelaySeconds} seconds. Front to Back:{' '}
        {delays.frontToBackDelayMs} milliseconds. Back to temporary:{' '}
        {delays.backToTemporaryDelayMs} milliseconds.
      </p>
      <ol className={styles.roleList}>
        {(
          [
            'funder',
            'developer',
            'front',
            'back',
            'temporary',
            'holders',
          ] as const
        ).flatMap((role) => {
          const value = roles[role];
          const entries = Array.isArray(value) ? value : value ? [value] : [];
          return entries.map((member, index) => (
            <li key={member.wallet.address}>
              <strong>
                {names[role]} {entries.length > 1 ? index + 1 : ''}
              </strong>{' '}
              <code>{member.wallet.address}</code>
              <span>
                Buy ≤ {layerDisplay(member.maximumBuyQuoteRaw, quote.decimals)}{' '}
                {quote.symbol}; fee ≤{' '}
                {layerDisplay(member.maximumNetworkFeeLamports, 9)} SOL; rent ≤{' '}
                {layerDisplay(member.maximumAccountRentLamports, 9)} SOL;
                reserve {layerDisplay(member.retainedNativeReserveLamports, 9)}{' '}
                SOL.
              </span>
            </li>
          ));
        })}
      </ol>
    </section>
  );
}
function Planner({
  selection,
  disabled = false,
}: {
  selection: LayerSelection;
  disabled?: boolean;
}) {
  const id = useId();
  const [context, setContext] = useState<LayerPlanningContext | null>(null);
  const [draft, setDraft] = useState<LayerDraft | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [historyRead, setHistoryRead] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [shared, setShared] = useState({ fee: '', rent: '', reserve: '' });
  const request = useRef<{
    controller: AbortController;
    generation: number;
  } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const run = async (
    label: string,
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) => {
    if (request.current || disabled) return;
    const controller = new AbortController(),
      mine = ++generation.current;
    request.current = { controller, generation: mine };
    setBusy(label);
    setError('');
    setNotice('');
    const current = () =>
      mounted.current &&
      generation.current === mine &&
      !controller.signal.aborted;
    const timer = setTimeout(() => {
      controller.abort();
      if (mounted.current && generation.current === mine) {
        generation.current++;
        request.current = null;
        setBusy('');
        setReview(null);
        setError(
          'Request timed out. Reload saved planning before retrying; a save may already have completed.',
        );
      }
    }, 30000);
    try {
      await work(controller.signal, current);
    } catch (e) {
      if (mounted.current && generation.current === mine)
        setError(
          controller.signal.aborted
            ? 'Request timed out. Reload saved planning before retrying; a save may already have completed.'
            : e instanceof Error
              ? e.message
              : 'Planning is unavailable.',
        );
    } finally {
      clearTimeout(timer);
      if (mounted.current && generation.current === mine) {
        request.current = null;
        setBusy('');
      }
    }
  };
  const load = () =>
    void run('Loading saved planning…', async (signal, current) => {
      const [contextResult, historyResult] = await Promise.allSettled([
        fetch(
          endpoint +
            '?context=' +
            encodeURIComponent(JSON.stringify(selection)),
          { signal, cache: 'no-store' },
        ).then(read),
        fetch(
          endpoint + '?projectId=' + encodeURIComponent(selection.projectId),
          { signal, cache: 'no-store' },
        ).then(read),
      ]);
      if (!current()) return;
      const failures: string[] = [];
      if (contextResult.status === 'fulfilled') {
        try {
          const loaded = parseLayerContext(
            contextResult.value.context,
            selection,
          );
          const initial = initialLayerDraft(loaded);
          layerQuote(loaded);
          setContext(loaded);
          setDraft(initial);
          setReview(null);
        } catch {
          setContext(null);
          setDraft(null);
          failures.push(
            'Current planning context could not be confirmed. Save the developer, complete holders and exact quote in the launch project, then reload.',
          );
        }
      } else {
        setContext(null);
        setDraft(null);
        setReview(null);
        failures.push(
          contextResult.reason instanceof Error
            ? contextResult.reason.message
            : 'Planning context is unavailable.',
        );
      }
      if (historyResult.status === 'fulfilled') {
        try {
          setSaved(
            historyResult.value.plan === null
              ? null
              : parseSavedLayer(historyResult.value.plan, selection.projectId),
          );
          setHistoryRead(true);
        } catch {
          setSaved(null);
          setHistoryRead(false);
          failures.push('Saved layer history could not be confirmed.');
        }
      } else {
        setSaved(null);
        setHistoryRead(false);
        failures.push(
          'Saved layer history is unavailable. Reload before saving a new plan.',
        );
      }
      if (failures.length) setError(failures.join(' '));
    });
  const dispose = useCallback(() => {
    mounted.current = false;
    generation.current++;
    request.current?.controller.abort();
    request.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return dispose;
  }, [dispose]);
  const edit = (next: LayerDraft) => {
    setDraft(next);
    setReview(null);
    setNotice('');
    setError('');
  };
  const quote = context ? layerQuote(context) : null;
  const blocked = disabled || !!busy;
  return (
    <section
      className={styles.panel}
      aria-label="Front and Back layer planning"
    >
      <h3>Front / Back layer planning</h3>
      <p>
        Plan distinct buyer and holder stages. Saving here does not configure
        the ordinary launch below. Staged funding and execution are not
        available yet.
      </p>
      <p className={styles.address}>
        Mint candidate: <code>{selection.target.mint}</code>
      </p>
      <Button variant="outline" disabled={blocked} onClick={load}>
        {context
          ? 'Reload context and saved plan'
          : 'Load saved wallets and layer history'}
      </Button>
      {draft && (
        <p>
          Reloading replaces unsaved role and budget edits with the current
          saved launch context.
        </p>
      )}
      {context && (
        <p>
          Saved project {context.projectId}, revision time{' '}
          {context.projectUpdatedAt}. Extra role selections use the account
          roster’s root scope; developer and final holders keep their saved
          folder references.
        </p>
      )}
      {draft && context && quote && (
        <>
          <fieldset disabled={blocked} className={styles.editor}>
            <legend>1. Assign roles and exact ceilings</legend>
            <p>
              Each address can appear once. Developer and final holders are
              locked to launch settings. Enter every fee, rent and reserve
              ceiling, including 0 when intended. Balances and key control have
              not been checked.
            </p>
            <details>
              <summary>Set shared fee and reserve ceilings</summary>
              <p>
                Copy explicit SOL ceilings to the current rows, then adjust any
                wallet individually. New rows start empty.
              </p>
              <div className={styles.fields}>
                {(['fee', 'rent', 'reserve'] as const).map((key) => (
                  <label key={key} htmlFor={id + '-shared-' + key}>
                    {key === 'fee'
                      ? 'Shared maximum network fee (SOL)'
                      : key === 'rent'
                        ? 'Shared maximum account rent (SOL)'
                        : 'Shared retained reserve (SOL)'}
                    <Input
                      id={id + '-shared-' + key}
                      inputMode="decimal"
                      value={shared[key]}
                      onChange={(e) => {
                        setShared({ ...shared, [key]: e.target.value });
                        setReview(null);
                      }}
                    />
                  </label>
                ))}
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  try {
                    for (const value of Object.values(shared))
                      layerAmount(value, 9);
                    edit({
                      ...draft,
                      rows: draft.rows.map((row) => ({ ...row, ...shared })),
                    });
                  } catch {
                    setError(
                      'Enter exact SOL ceilings for all three shared fields before applying them.',
                    );
                  }
                }}
              >
                Apply shared ceilings to current rows
              </Button>
            </details>
            {draft.rows.map((row, index) => {
              const fixed = row.role === 'developer' || row.role === 'holders';
              const noBuy = row.role === 'funder' || row.role === 'temporary';
              const update = (
                key: 'buy' | 'fee' | 'rent' | 'reserve',
                value: string,
              ) =>
                edit({
                  ...draft,
                  rows: draft.rows.map((r) =>
                    r.id === row.id ? { ...r, [key]: value } : r,
                  ),
                });
              const selected = new Set(
                draft.rows
                  .filter((r) => r.id !== row.id)
                  .map((r) => r.wallet?.address),
              );
              return (
                <fieldset
                  key={row.id}
                  className={styles.row}
                  aria-label={`${names[row.role]} row ${index + 1}`}
                >
                  <legend>{names[row.role]}</legend>
                  {fixed ? (
                    <p className={styles.address}>
                      Saved wallet: <code>{row.wallet?.address}</code>
                    </p>
                  ) : (
                    <label htmlFor={id + row.id + '-wallet'}>
                      Wallet (root scope)
                      <select
                        id={id + row.id + '-wallet'}
                        value={row.wallet?.address ?? ''}
                        onChange={(e) => {
                          const wallet = context.workspace.wallets.find(
                            (w) => w.address === e.target.value && !w.archived,
                          );
                          edit({
                            ...draft,
                            rows: draft.rows.map((r) =>
                              r.id === row.id
                                ? {
                                    ...r,
                                    wallet: wallet
                                      ? {
                                          address: wallet.address,
                                          revision: wallet.revision,
                                          folderRevision: 0,
                                          root: true,
                                        }
                                      : undefined,
                                  }
                                : r,
                            ),
                          });
                        }}
                      >
                        <option value="">Choose a saved wallet</option>
                        {context.workspace.wallets
                          .filter((w) => !w.archived && w.chain === 'Solana')
                          .map((w) => (
                            <option
                              key={w.address}
                              value={w.address}
                              disabled={selected.has(w.address)}
                            >
                              {w.label ? w.label + ' · ' : ''}
                              {w.address}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <div className={styles.fields}>
                    <label htmlFor={id + row.id + '-buy'}>
                      Maximum buy ({quote.symbol})
                      <Input
                        id={id + row.id + '-buy'}
                        inputMode="decimal"
                        value={row.buy}
                        disabled={noBuy}
                        onChange={(e) => update('buy', e.target.value)}
                      />
                    </label>
                    <label htmlFor={id + row.id + '-fee'}>
                      Maximum network fee (SOL)
                      <Input
                        id={id + row.id + '-fee'}
                        inputMode="decimal"
                        value={row.fee}
                        onChange={(e) => update('fee', e.target.value)}
                      />
                    </label>
                    <label htmlFor={id + row.id + '-rent'}>
                      Maximum account rent (SOL)
                      <Input
                        id={id + row.id + '-rent'}
                        inputMode="decimal"
                        value={row.rent}
                        onChange={(e) => update('rent', e.target.value)}
                      />
                    </label>
                    <label htmlFor={id + row.id + '-reserve'}>
                      Retained reserve (SOL)
                      <Input
                        id={id + row.id + '-reserve'}
                        inputMode="decimal"
                        value={row.reserve}
                        onChange={(e) => update('reserve', e.target.value)}
                      />
                    </label>
                  </div>
                  {!fixed && row.role !== 'funder' && (
                    <Button
                      variant="outline"
                      disabled={
                        (row.role === 'front' &&
                          draft.rows.filter((r) => r.role === 'front')
                            .length === 1) ||
                        (row.role === 'back' &&
                          draft.rows.filter((r) => r.role === 'back').length ===
                            1 &&
                          draft.rows.some((r) => r.role === 'temporary'))
                      }
                      onClick={() => {
                        const rows = draft.rows.filter((r) => r.id !== row.id);
                        edit({
                          ...draft,
                          rows,
                          frontToBackDelayMs: rows.some(
                            (r) => r.role === 'back',
                          )
                            ? draft.frontToBackDelayMs
                            : '0',
                          backToTemporaryDelayMs: rows.some(
                            (r) => r.role === 'temporary',
                          )
                            ? draft.backToTemporaryDelayMs
                            : '0',
                        });
                      }}
                    >
                      Remove {names[row.role]}
                    </Button>
                  )}
                  {row.role === 'front' &&
                    draft.rows.filter((r) => r.role === 'front').length ===
                      1 && <p>Keep at least one Front buyer.</p>}
                  {row.role === 'back' &&
                    draft.rows.filter((r) => r.role === 'back').length === 1 &&
                    draft.rows.some((r) => r.role === 'temporary') && (
                      <p>
                        Remove temporary holders before removing the last Back
                        buyer.
                      </p>
                    )}
                  {noBuy && <p>This role has no purchase budget.</p>}
                </fieldset>
              );
            })}
            <div className={styles.actions}>
              {(['front', 'back', 'temporary'] as const).map((role) => (
                <Button
                  key={role}
                  variant="outline"
                  disabled={
                    draft.rows.length >= 500 ||
                    draft.rows.filter((r) => r.role === role).length >=
                      (context.document.plan.launchpad === 'StonkFun'
                        ? 12
                        : 200) ||
                    (context.document.plan.launchpad === 'StonkFun' &&
                      role !== 'front') ||
                    (role === 'temporary' &&
                      !draft.rows.some((r) => r.role === 'back'))
                  }
                  onClick={() =>
                    edit({
                      ...draft,
                      rows: [...draft.rows, newLayerRow(role)].sort(
                        (a, b) =>
                          [
                            'funder',
                            'developer',
                            'front',
                            'back',
                            'temporary',
                            'holders',
                          ].indexOf(a.role) -
                          [
                            'funder',
                            'developer',
                            'front',
                            'back',
                            'temporary',
                            'holders',
                          ].indexOf(b.role),
                      ),
                    })
                  }
                >
                  Add {names[role]}
                </Button>
              ))}
            </div>
            <p>
              Maximum 200 per optional role and 500 wallets overall. Temporary
              holders require a Back layer. StonkFun is limited to 12 Front
              buyers, with no Back or temporary layer.
            </p>
            <div className={styles.fields}>
              <label htmlFor={id + '-funding-delay'}>
                Funding delay (seconds, 0–86400)
                <Input
                  id={id + '-funding-delay'}
                  inputMode="numeric"
                  value={draft.fundingDelaySeconds}
                  onChange={(e) =>
                    edit({ ...draft, fundingDelaySeconds: e.target.value })
                  }
                />
              </label>
              <label htmlFor={id + '-front-delay'}>
                Front to Back delay (milliseconds, 0–10000)
                <Input
                  id={id + '-front-delay'}
                  inputMode="numeric"
                  disabled={!draft.rows.some((r) => r.role === 'back')}
                  value={draft.frontToBackDelayMs}
                  onChange={(e) =>
                    edit({ ...draft, frontToBackDelayMs: e.target.value })
                  }
                />
              </label>
              <label htmlFor={id + '-temp-delay'}>
                Back to temporary delay (milliseconds, 0–10000)
                <Input
                  id={id + '-temp-delay'}
                  inputMode="numeric"
                  disabled={!draft.rows.some((r) => r.role === 'temporary')}
                  value={draft.backToTemporaryDelayMs}
                  onChange={(e) =>
                    edit({ ...draft, backToTemporaryDelayMs: e.target.value })
                  }
                />
              </label>
            </div>
            <Button
              onClick={() =>
                void run(
                  'Reviewing planning ceilings…',
                  async (_signal, current) => {
                    const captured = structuredClone(draft),
                      envelope = await reviewLayerDraft(captured, context);
                    if (current()) setReview({ draft: captured, envelope });
                  },
                )
              }
            >
              Review layer ceilings
            </Button>
          </fieldset>
          {review && (
            <>
              <BudgetReview envelope={review.envelope} />
              <Button
                disabled={blocked || !historyRead}
                onClick={() =>
                  void run(
                    'Saving planning snapshot…',
                    async (signal, current) => {
                      const value = await fetch(endpoint, {
                        method: 'POST',
                        signal,
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          ...selection,
                          layers: layerRequest(review.draft, context),
                        }),
                      }).then(read);
                      const retained = parseSavedLayer(
                        value.plan,
                        selection.projectId,
                      );
                      if (
                        retained.projectUpdatedAt !==
                          selection.projectUpdatedAt ||
                        JSON.stringify({
                          ...retained.envelope.terms,
                          binding: {
                            ...retained.envelope.terms.binding,
                            ownerId: review.envelope.terms.binding.ownerId,
                          },
                        }) !== JSON.stringify(review.envelope.terms)
                      )
                        throw new Error(
                          'Saved plan differs from this review. Reload saved history before retrying.',
                        );
                      if (current()) {
                        setSaved(retained);
                        setNotice(
                          retained.current
                            ? 'Planning snapshot saved. Nothing was funded and ordinary launch settings were not changed.'
                            : 'Planning snapshot saved as history; current references changed. Reload context before reviewing another plan.',
                        );
                      }
                    },
                  )
                }
              >
                Save reviewed planning snapshot
              </Button>
              {!historyRead && (
                <p>Reload saved history before saving a new snapshot.</p>
              )}
            </>
          )}
        </>
      )}
      {historyRead && !saved && <p>No saved layer plan for this project.</p>}
      {saved && (
        <details className={styles.history}>
          <summary>
            Saved planning snapshot ·{' '}
            {new Date(saved.createdAt).toLocaleString()}
          </summary>
          <p>
            {saved.current
              ? 'Saved references still match the current project and roster.'
              : 'Current references could not be confirmed. Keep this as history; reload and review current settings before creating a new plan.'}
          </p>
          {saved.envelope.terms.binding.target.mint !==
            selection.target.mint && (
            <p>
              This snapshot belongs to a different mint candidate. It is
              history, not the plan currently being edited.
            </p>
          )}
          <p className={styles.address}>
            Saved mint candidate:{' '}
            <code>{saved.envelope.terms.binding.target.mint}</code>
          </p>
          <p className={styles.address}>
            Plan ID: <code>{saved.id}</code>
          </p>
          <BudgetReview envelope={saved.envelope} />
          <Button
            variant="outline"
            disabled={
              blocked ||
              !context ||
              !saved.current ||
              saved.envelope.terms.binding.target.mint !== selection.target.mint
            }
            onClick={() =>
              void run(
                'Reopening planning ceilings…',
                async (_signal, current) => {
                  if (!context || !saved.current) return;
                  const reopened = await reopenLayerDraft(
                    saved.envelope,
                    context,
                  );
                  if (current()) {
                    edit(reopened);
                    setNotice(
                      'Saved ceilings copied into a new draft. Review them again before saving.',
                    );
                  }
                },
              )
            }
          >
            Use saved ceilings as a new draft
          </Button>
          {(!context ||
            !saved.current ||
            saved.envelope.terms.binding.target.mint !==
              selection.target.mint) && (
            <p>
              Reopening requires matching current source, mint and wallet
              references. Historical snapshots remain readable.
            </p>
          )}
        </details>
      )}
      <div aria-live="polite">
        {busy && <p>{busy}</p>}
        {notice && <p>{notice}</p>}
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && (
        <Button
          variant="outline"
          onClick={() => {
            request.current?.controller.abort();
            request.current = null;
            generation.current++;
            setBusy('');
            setReview(null);
            setNotice(
              'Request cancelled locally. Reload saved history: cancellation does not prove a save was prevented.',
            );
          }}
        >
          Cancel planning request
        </Button>
      )}
    </section>
  );
}
export function PumpLayerPlanner(props: Parameters<typeof Planner>[0]) {
  return <Planner key={JSON.stringify(props.selection)} {...props} />;
}
