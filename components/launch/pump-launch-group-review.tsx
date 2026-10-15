'use client';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readPanelJson } from '@/components/read-panel-json';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from '@/lib/pump-holder-review';
import { holderDisplayRaw } from '@/lib/pump-holder-launch-client';
import {
  parsePumpGroupView,
  parsePumpGroupPage,
  parsePumpGroupObservation,
  type PumpGroupView,
  type PumpGroupSummary,
  type PumpGroupObservationView,
} from '@/lib/pump-launch-group-client';
import styles from './pump-launch-group-ui.module.css';

const endpoint = '/api/launch/pump/groups';
const labels = {
  review: 'Unsigned review',
  approved: 'Approval saved, signing disabled',
  signed: 'Signed group retained',
  cancelled: 'Discarded unsigned review',
};
const observationLabels = {
  complete: 'Every packet finalized successfully',
  failed: 'Every packet finalized with a failure',
  partial: 'Partial packet results',
  'expired-unobserved': 'Expired, no finalized receipt observed',
  unknown: 'Outcome unknown',
  pending: 'Awaiting finalized packet results',
};
type Props = {
  projectId: string;
  contextKey: string;
  prepareRequest: () => Record<string, unknown>;
  canPrepare: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function buyDescription(view: PumpGroupView, index: number) {
  const target = view.review.input.holders[index];
  const limit = view.review.allowances.holders[index];
  if (target.kind === 'none')
    return 'No buy. This zero allocation stays in the saved selection.';
  if (target.kind === 'exact-quote-input')
    return `Saved quote input: ${holderDisplayRaw(target.quoteAmountRaw, view.quoteDecimals)} ${view.review.document.plan.currency}. Minimum tokens received: ${limit.minimumTokenOutputRaw === null ? 'Unavailable' : holderDisplayRaw(limit.minimumTokenOutputRaw, 6)}.`;
  return `Exact token target: ${holderDisplayRaw(target.tokenAmountRaw, 6)}. Maximum quote spend: ${limit.maximumQuoteCostRaw === null ? 'Unavailable' : holderDisplayRaw(limit.maximumQuoteCostRaw, view.quoteDecimals)} ${view.review.document.plan.currency}.`;
}
function Panel({
  projectId,
  contextKey,
  prepareRequest,
  canPrepare,
  disabled = false,
  onBusyChange,
}: Props) {
  const [rows, setRows] = useState<PumpGroupSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [view, setView] = useState<PumpGroupView | null>(null),
    [preparedContext, setPreparedContext] = useState<string | null>(null);
  const [observations, setObservations] = useState<PumpGroupObservationView[]>(
      [],
    ),
    [observationCursor, setObservationCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const active = useRef(true),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  function current() {
    if (!active.current || controller.current?.signal.aborted)
      throw new Error('Group context changed.');
  }
  async function request(query = '', body?: Record<string, unknown>) {
    const response = await fetch(endpoint + query, {
      ...(body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
      signal: AbortSignal.any([
        controller.current!.signal,
        AbortSignal.timeout(65000),
      ]),
    });
    current();
    if (response.status === 429)
      throw new Error(
        'Wait 5 seconds before repeating this group action. Saved history remains available.',
      );
    if (response.status === 401)
      throw new Error('Sign in again to read complete launch groups.');
    if ([400, 404, 409].includes(response.status))
      throw new Error(
        'Complete launch group service could not accept this plan or saved state. Review every wallet limit and reload saved groups. Groups above five packets are unsupported.',
      );
    if (!response.ok)
      throw new Error(
        'Complete launch group service is unavailable. Reload saved groups before retrying; no signing or broadcast occurred here.',
      );
    return readPanelJson(
      response,
      'Complete launch group service is unavailable.',
    );
  }
  async function run(action: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true;
    controller.current = new AbortController();
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error &&
            /^(Wait 5 seconds|Sign in again|Complete launch group service)/.test(
              e.message,
            )
            ? e.message
            : 'Group check did not complete. Reload saved groups before retrying.',
        );
    } finally {
      running.current = false;
      if (active.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  async function history(older = false) {
    const previous = older ? cursor : null;
    if (older && !previous) return;
    const page = parsePumpGroupPage(
      await request(
        '?projectId=' +
          encodeURIComponent(projectId) +
          '&page=1' +
          (previous ? '&cursor=' + encodeURIComponent(previous) : ''),
      ),
      projectId,
      previous ?? undefined,
    );
    if (
      older &&
      page.rows.some((row) => rows.some((existing) => existing.id === row.id))
    )
      throw new Error('Overlapping group history.');
    current();
    setRows((all) => (older ? [...all, ...page.rows] : page.rows));
    setCursor(page.nextCursor);
    setLoaded(true);
  }
  async function open(id: string) {
    const checked = await parsePumpGroupView(
      await request('?id=' + encodeURIComponent(id)),
      projectId,
      controller.current!.signal,
    );
    if (checked.review.id !== id) throw new Error('Saved group differs.');
    current();
    setView(checked);
    setPreparedContext(null);
    setObservations([]);
    setObservationCursor(null);
  }
  async function observationHistory(older = false) {
    if (!view || (older && !observationCursor)) return;
    const previous = older ? observationCursor : null;
    const page = await request(
      '?id=' +
        encodeURIComponent(view.review.id) +
        '&observations=1' +
        (previous ? '&cursor=' + encodeURIComponent(previous) : ''),
    );
    if (
      !record(page) ||
      !Array.isArray(page.observations) ||
      page.observations.length > 20 ||
      !(
        page.nextCursor === null ||
        (typeof page.nextCursor === 'string' &&
          /^[A-Za-z0-9_-]{1,2048}$/.test(page.nextCursor))
      ) ||
      (page.nextCursor === previous && previous !== null) ||
      (page.nextCursor !== null && !page.observations.length)
    )
      throw new Error('Invalid observation history.');
    const checked = await Promise.all(
      page.observations.map((row) => parsePumpGroupObservation(row, view)),
    );
    if (
      new Set(checked.map((row) => row.id)).size !== checked.length ||
      (older &&
        checked.some((row) =>
          observations.some((existing) => existing.id === row.id),
        ))
    )
      throw new Error('Overlapping observation history.');
    current();
    setObservations((all) => (older ? [...all, ...checked] : checked));
    setObservationCursor(page.nextCursor as string | null);
  }
  const loadOnOpen = useEffectEvent(() => void run(() => history()));
  useEffect(() => {
    const timer = setTimeout(() => loadOnOpen(), 0);
    return () => clearTimeout(timer);
  }, []);
  const locked = disabled || busy;
  const review = view?.review;
  return (
    <section
      className={styles.panel}
      aria-label="Complete PumpFun launch groups"
    >
      <h3>Complete launch groups</h3>
      <p>
        Review the creation, developer buy and all selected holder buys
        together, across up to five packets. Every packet stays in the group.
        Preparing a saved review reserves its wallets until it can be discarded
        or safely recovered.
      </p>
      <p className="source-note">
        Group signing and execution are unavailable while runtime, program
        authority and submission policy checks are unfinished. No key unlock,
        approval, signing or broadcast is offered here.
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          disabled={
            locked || !canPrepare || (!!view && view.state !== 'cancelled')
          }
          onClick={() =>
            void run(async () => {
              const capturedContext = contextKey;
              const checked = await parsePumpGroupView(
                await request('', { ...prepareRequest(), action: 'prepare' }),
                projectId,
                controller.current!.signal,
              );
              if (checked.state !== 'review' || checked.signedEvidence !== null)
                throw new Error('Preparation state differs.');
              current();
              setView(checked);
              setPreparedContext(capturedContext);
              setObservations([]);
              setObservationCursor(null);
              await history();
            })
          }
        >
          Simulate complete launch group
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => void run(() => history())}
        >
          Reload saved groups
        </Button>
      </div>
      {!canPrepare && (
        <p>
          To prepare a group, save the unscheduled plan, metadata release and
          verified deployer, restore and acknowledge the mint backup, read
          holder targets, and review every wallet limit. Finish or discard any
          active one-packet launch.
        </p>
      )}
      <ul className={styles.history}>
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{labels[row.state]}</strong>{' '}
            <time dateTime={row.createdAt ?? undefined}>
              {row.createdAt
                ? new Date(row.createdAt).toLocaleString()
                : 'Saved date unavailable'}
            </time>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              aria-label={`Open complete group: ${row.id}`}
              onClick={() => void run(() => open(row.id))}
            >
              Open complete saved group
            </Button>
          </li>
        ))}
      </ul>
      {loaded && !rows.length && <p>No saved complete groups.</p>}
      {cursor && (
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => void run(() => history(true))}
        >
          Load older complete groups
        </Button>
      )}
      {view && review && (
        <div className={styles.review}>
          <h4>
            {review.document.plan.tokenName}: {labels[view.state]}
          </h4>
          <p>
            Review {review.id}. Expires{' '}
            <time dateTime={review.expiresAt}>
              {new Date(review.expiresAt).toLocaleString()}
            </time>
            . Refresh checks keep the original expiry.
          </p>
          {preparedContext && preparedContext !== contextKey && (
            <p role="alert">
              The current draft or limits changed after preparation. This saved
              group still contains its original terms.
            </p>
          )}
          <p>
            Quote asset: {review.document.plan.currency}. Simulated network
            fees: {holderDisplayRaw(review.simulation.networkFeeRaw, 9)} SOL.
            Simulation is evidence for these saved bytes, not funded execution
            or atomicity.
          </p>
          <p>
            Mint: <code>{review.input.create.mint}</code>. Quote mint:{' '}
            <code>{review.input.create.quoteMint}</code>.
          </p>
          <details>
            <summary>Exact group identities</summary>
            <dl>
              <dt>Manifest</dt>
              <dd>{review.manifestSha256}</dd>
              <dt>Context</dt>
              <dd>{review.contextSha256}</dd>
              <dt>Simulation</dt>
              <dd>{review.simulationSha256}</dd>
            </dl>
          </details>
          <ol className={styles.packets}>
            {review.packets.map((packet) => (
              <li key={packet.sha256}>
                <h4>
                  Packet {packet.index + 1} of {review.packets.length}
                </h4>
                <p>
                  {packet.index === 0
                    ? 'Coin creation and developer buy where selected. '
                    : ''}
                  Holder slots:{' '}
                  {packet.holderIndices.length
                    ? packet.holderIndices.map((index) => index + 1).join(', ')
                    : 'None'}
                  .
                </p>
                <details>
                  <summary>
                    {packet.requiredSigners.length} required signers and packet
                    identity
                  </summary>
                  <code>{packet.sha256}</code>
                  <ul>
                    {packet.requiredSigners.map((address) => (
                      <li key={address}>
                        <code>{address}</code>
                      </li>
                    ))}
                  </ul>
                </details>
                {view.signedEvidence && (
                  <a
                    href={
                      'https://solscan.io/tx/' +
                      view.signedEvidence.packets[packet.index].signature
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    View packet {packet.index + 1} transaction
                  </a>
                )}
              </li>
            ))}
          </ol>
          <details>
            <summary>Every wallet&apos;s saved limits</summary>
            <p>
              Deployer fee and rent cap:{' '}
              {holderDisplayRaw(
                review.allowances.deployerFeeAndRentLimitRaw,
                9,
              )}{' '}
              SOL. Developer quote cap:{' '}
              {review.allowances.developerMaximumQuoteCostRaw === null
                ? 'No developer buy'
                : holderDisplayRaw(
                    review.allowances.developerMaximumQuoteCostRaw,
                    view.quoteDecimals,
                  ) +
                  ' ' +
                  review.document.plan.currency}
              .
            </p>
            <ul>
              {review.allowances.holders.map((wallet, index) => (
                <li key={wallet.address}>
                  Holder {index + 1}: <code>{wallet.address}</code>. Fee and
                  rent cap: {holderDisplayRaw(wallet.feeAndRentLimitRaw, 9)}{' '}
                  SOL. {buyDescription(view, index)}
                </li>
              ))}
            </ul>
          </details>
          <div className={styles.actions}>
            {['review', 'approved'].includes(view.state) && (
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    const fresh = await request('', {
                      action: 'revalidate',
                      id: review.id,
                    });
                    if (
                      !record(fresh) ||
                      fresh.reviewContextSha256 !== review.contextSha256 ||
                      fresh.originalReviewExpiresAt !== review.expiresAt ||
                      fresh.sourceRevalidated !== true ||
                      fresh.signingAllowed !== false ||
                      fresh.executionAllowed !== false ||
                      !record(fresh.checked) ||
                      fresh.simulationSha256 !==
                        (await pumpHolderDigest(fresh.checked.simulation))
                    )
                      throw new Error('Revalidation differs.');
                    const checked = await parsePumpGroupView(
                      await request('?id=' + encodeURIComponent(review.id)),
                      projectId,
                      controller.current!.signal,
                    );
                    if (
                      canonicalPumpHolderJson(checked.review) !==
                      canonicalPumpHolderJson(review)
                    )
                      throw new Error('Review changed.');
                    current();
                    setView(checked);
                    setNotice(
                      'Saved sources checked again. Signing and execution remain disabled.',
                    );
                  })
                }
              >
                Recheck complete group sources
              </Button>
            )}
            {view.state === 'review' && (
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    const checked = await parsePumpGroupView(
                      await request('', { action: 'cancel', id: review.id }),
                      projectId,
                      controller.current!.signal,
                    );
                    if (
                      checked.state !== 'cancelled' ||
                      canonicalPumpHolderJson(checked.review) !==
                        canonicalPumpHolderJson(review)
                    )
                      throw new Error('Discard differs.');
                    current();
                    setView(checked);
                    await history();
                    setNotice('Unsigned group discarded.');
                  })
                }
              >
                Discard unsigned complete group
              </Button>
            )}
            {['approved', 'signed'].includes(view.state) && (
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    const checked = await parsePumpGroupObservation(
                      await request('', { action: 'observe', id: review.id }),
                      view,
                    );
                    current();
                    setObservations([checked]);
                    setObservationCursor(null);
                  })
                }
              >
                Check every packet status
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void run(() => observationHistory())}
            >
              Load saved group observations
            </Button>
          </div>
          {observations.map((observation) => (
            <article key={observation.id}>
              <h4>{observationLabels[observation.state]}</h4>
              <time dateTime={observation.createdAt}>
                {new Date(observation.createdAt).toLocaleString()}
              </time>
              <p>
                {observation.receipt.observedPacketCount} of{' '}
                {review.packets.length} packets finalized. Known network fees:{' '}
                {holderDisplayRaw(observation.receipt.knownNetworkFeeRaw, 9)}{' '}
                SOL
                {observation.receipt.networkFeeUnresolved
                  ? '; some fees remain unresolved'
                  : ''}
                . This observation does not prove atomicity, settle balances or
                release reservations.
              </p>
            </article>
          ))}
          {observationCursor && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void run(() => observationHistory(true))}
            >
              Load older group observations
            </Button>
          )}
        </div>
      )}
      <div aria-live="polite">
        {busy && <p>Checking complete launch group...</p>}
        {notice && <p>{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
export function PumpLaunchGroupReview(props: Props) {
  return <Panel key={props.projectId} {...props} />;
}
