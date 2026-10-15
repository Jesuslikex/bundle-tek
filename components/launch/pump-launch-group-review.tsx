'use client';
import {
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useRef,
  useState,
  useCallback,
} from 'react';
import {
  requirePumpRuntimePreview,
  requirePumpSigningAuthorization,
  groupSigningConsent,
  type PumpGroupRuntimePreview,
} from '@/lib/pump-group-runtime-authorization';
import type { PumpGroupSignAction } from '@/lib/pump-group-signing-scope';
import { verifyPumpLaunchGroupSignatures } from '@/lib/pump-launch-group-signatures';
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
  parsePumpGroupRecoveryResult,
  type PumpGroupView,
  type PumpGroupSummary,
  type PumpGroupObservationView,
} from '@/lib/pump-launch-group-client';
import styles from './pump-launch-group-ui.module.css';
import { PumpGroupBroadcast } from './pump-group-broadcast';
import type { PumpGroupTipSignAction } from '@/lib/pump-group-broadcast-client';

const endpoint = '/api/launch/pump/groups';
const labels = {
  review: 'Unsigned review',
  approved: 'Approval saved, fresh signing authorization required',
  signed: 'Signed group retained',
  cancelled: 'Closed review',
  failed: 'All packets finalized as failures',
  finalized: 'Launch packets and tip finalized',
};
const observationLabels = {
  complete: 'Every packet finalized successfully',
  failed: 'Every packet finalized with a failure',
  partial: 'Partial packet results',
  'expired-unobserved': 'Expired, no finalized receipt observed',
  unknown: 'Outcome unknown',
  pending: 'Awaiting finalized packet results',
};
type Pending = {
  contextSha256: string;
  transactions: string[];
  signedGroupSha256: string;
};
const pendingKey = (id: string) => 'bundle.pump-group-signed.v1:' + id;
function downloadGroup(review: PumpGroupView['review'], pending: Pending) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ review, ...pending })], {
      type: 'application/json',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bundle-complete-group-' + review.id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type Props = {
  projectId: string;
  contextKey: string;
  prepareRequest: () => Record<string, unknown>;
  canPrepare: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  canSign?: (view: PumpGroupView) => boolean;
  onSign?: PumpGroupSignAction;
  canSignTip?: boolean;
  onSignTip?: PumpGroupTipSignAction;
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
  canSign,
  onSign,
  canSignTip,
  onSignTip,
}: Props) {
  const [rows, setRows] = useState<PumpGroupSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastExists, setBroadcastExists] = useState(false);
  const broadcastBusyChanged = useCallback(
    (value: boolean) => {
      setBroadcastBusy(value);
      onBusyChange?.(value);
    },
    [onBusyChange],
  );
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
  const [runtimePreview, setRuntimePreview] =
      useState<PumpGroupRuntimePreview | null>(null),
    [previewContext, setPreviewContext] = useState('');
  const [previewExpired, setPreviewExpired] = useState(true);
  useEffect(() => {
    const expires = runtimePreview ? Date.parse(runtimePreview.expiresAt) : 0;
    const refresh = () => setPreviewExpired(expires <= Date.now());
    const initial = setTimeout(refresh, 0);
    const timer = setTimeout(refresh, Math.max(0, expires - Date.now()));
    return () => {
      clearTimeout(initial);
      clearTimeout(timer);
    };
  }, [runtimePreview]);
  const [approveAll, setApproveAll] = useState(false),
    [simulationAck, setSimulationAck] = useState(false),
    [codeApproval, setCodeApproval] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null),
    [pendingProblem, setPendingProblem] = useState(false);
  const signingState = useRef({
    contextKey,
    context: view?.review.contextSha256,
    previewId: runtimePreview?.id,
    approveAll,
    simulationAck,
    codeApproval,
  });
  useLayoutEffect(() => {
    signingState.current = {
      contextKey,
      context: view?.review.contextSha256,
      previewId: runtimePreview?.id,
      approveAll,
      simulationAck,
      codeApproval,
    };
  }, [
    contextKey,
    view?.review.contextSha256,
    runtimePreview?.id,
    approveAll,
    simulationAck,
    codeApproval,
  ]);
  const resetSigning = () => {
    setApproveAll(false);
    setSimulationAck(false);
    setCodeApproval(false);
  };
  async function retained(checked: PumpGroupView) {
    const stored = localStorage.getItem(pendingKey(checked.review.id));
    if (!stored) {
      setPending(
        checked.signedEvidence
          ? {
              contextSha256: checked.review.contextSha256,
              transactions: checked.signedEvidence.packets.map(
                (packet) => packet.transaction,
              ),
              signedGroupSha256: checked.signedEvidence.signedGroupSha256,
            }
          : null,
      );
      setPendingProblem(false);
      return;
    }
    try {
      if (stored.length > 40000) throw new Error();
      const parsed = JSON.parse(stored) as Pending;
      if (
        parsed.contextSha256 !== checked.review.contextSha256 ||
        !Array.isArray(parsed.transactions)
      )
        throw new Error();
      const evidence = await verifyPumpLaunchGroupSignatures(
        checked.review,
        parsed.transactions,
        controller.current!.signal,
      );
      if (evidence.signedGroupSha256 !== parsed.signedGroupSha256)
        throw new Error();
      current();
      setPending(parsed);
      setPendingProblem(false);
    } catch {
      if (checked.signedEvidence) {
        setPending({
          contextSha256: checked.review.contextSha256,
          transactions: checked.signedEvidence.packets.map(
            (packet) => packet.transaction,
          ),
          signedGroupSha256: checked.signedEvidence.signedGroupSha256,
        });
        setPendingProblem(false);
        setNotice(
          'The browser backup differs. The verified complete group from saved history is available for download.',
        );
        return;
      }
      setPendingProblem(true);
      setNotice(
        'The stored signed group could not be verified. Restore its original complete packet vector before signing again.',
      );
      throw new Error('Stored group differs.');
    }
  }
  async function registerRetained(checked: PumpGroupView, captured: Pending) {
    await verifyPumpLaunchGroupSignatures(
      checked.review,
      captured.transactions,
      controller.current!.signal,
    );
    current();
    const updated = await parsePumpGroupView(
      await request('', {
        action: 'register',
        id: checked.review.id,
        consent: groupSigningConsent(checked.review),
        transactions: captured.transactions,
      }),
      projectId,
      controller.current!.signal,
    );
    if (
      updated.state !== 'signed' ||
      updated.signedEvidence?.signedGroupSha256 !== captured.signedGroupSha256
    )
      throw new Error('Registered group differs.');
    current();
    setView(updated);
    resetSigning();
  }
  const active = useRef(true),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);

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
        'Complete launch group service is unavailable. Keep any retained signed group and reload saved history before retrying.',
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
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
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
    resetSigning();
    setRuntimePreview(null);
    const checked = await parsePumpGroupView(
      await request('?id=' + encodeURIComponent(id)),
      projectId,
      controller.current!.signal,
    );
    if (checked.review.id !== id) throw new Error('Saved group differs.');
    current();
    await retained(checked);
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
  const locked = disabled || busy || broadcastBusy;
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
        Group broadcasting requires separate approval of the complete bundle and
        tip. Signing requires fresh source checks, explicit approval of every
        packet and wallet limit, and approval of the exact deployed code
        identities below. Keys stay in this browser.
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          disabled={
            locked ||
            !canPrepare ||
            (!!view &&
              !['cancelled', 'failed', 'finalized'].includes(view.state))
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
              setPending(null);
              setPendingProblem(false);
              setRuntimePreview(null);
              resetSigning();
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
          {view.receipt && (
            <output>
              {view.receipt.format === 'pump-launch-group-broadcast-terminal-v1'
                ? 'Complete broadcast pending-execution proof saved. '
                : view.receipt.kind === 'expired-unobserved'
                  ? 'Expired group closed after finalized mint absence.'
                  : 'Every packet finalized as a failure.'}{' '}
              Wallet reservations were released by the saved recovery event.{' '}
              {view.receipt.networkFeeUnresolved
                ? 'Network fees remain unresolved.'
                : 'Known network fees are retained.'}{' '}
              Economic settlement is not established.
            </output>
          )}
          {onSign && ['review', 'approved'].includes(view.state) && (
            <section
              aria-label="User-approved complete group signing"
              className={styles.review}
            >
              <h4>Review and sign the complete group</h4>
              <p>
                Enter the mint and wallet vault passphrases in the fields above
                and acknowledge the encrypted mint backup. The saved draft and
                every wallet limit must still match this review. Signing does
                not broadcast.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={locked || !!pending || pendingProblem}
                onClick={() =>
                  void run(async () => {
                    resetSigning();
                    setRuntimePreview(null);
                    const captured = contextKey;
                    const preview = await requirePumpRuntimePreview(
                      await request('', {
                        action: 'runtime-preview',
                        id: review.id,
                      }),
                      review,
                    );
                    current();
                    setRuntimePreview(preview);
                    setPreviewContext(captured);
                    void import('@/lib/pump-launch-group-signing').catch(
                      () => undefined,
                    );
                  })
                }
              >
                Read deployed group program identities
              </Button>
              {runtimePreview && (
                <>
                  <p>
                    Exact code identities read at{' '}
                    <time dateTime={runtimePreview.createdAt}>
                      {new Date(runtimePreview.createdAt).toLocaleString()}
                    </time>
                    . This review expires{' '}
                    <time dateTime={runtimePreview.expiresAt}>
                      {new Date(runtimePreview.expiresAt).toLocaleString()}
                    </time>
                    . These identity checks do not establish a semantic code
                    audit.
                  </p>
                  <ul>
                    {runtimePreview.programs.map((program) => (
                      <li key={program.address}>
                        <a
                          href={'https://solscan.io/account/' + program.address}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {program.address}
                        </a>
                        <div>
                          {program.identityKind === 'native-system'
                            ? 'Native System account identity SHA-256'
                            : 'Deployed ELF code SHA-256'}
                          : <code>{program.codeSha256}</code>
                        </div>
                        <div>
                          Upgrade authority:{' '}
                          <code>
                            {program.upgradeAuthority ??
                              'None reported for this executable'}
                          </code>
                          . Deployment slot:{' '}
                          {program.deploymentSlot ??
                            'Immutable or native executable'}
                          .
                        </div>
                      </li>
                    ))}
                  </ul>
                  {previewContext !== contextKey && (
                    <p role="alert">
                      The draft or limits changed. Restore the saved scope and
                      refresh this runtime review.
                    </p>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={approveAll}
                      disabled={
                        locked || !!pending || previewContext !== contextKey
                      }
                      onChange={(event) => setApproveAll(event.target.checked)}
                    />{' '}
                    I approve signing every packet in this exact group, every
                    active wallet buy and all displayed limits.
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={simulationAck}
                      disabled={
                        locked || !!pending || previewContext !== contextKey
                      }
                      onChange={(event) =>
                        setSimulationAck(event.target.checked)
                      }
                    />{' '}
                    I understand simulation does not prove funded execution,
                    atomic inclusion or realized settlement.
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={codeApproval}
                      disabled={
                        locked || !!pending || previewContext !== contextKey
                      }
                      onChange={(event) =>
                        setCodeApproval(event.target.checked)
                      }
                    />{' '}
                    I approve these exact deployed code hashes and listed
                    upgrade authorities. I understand code can be upgradeable
                    and these checks are not a semantic audit.
                  </label>
                  <Button
                    type="button"
                    disabled={
                      locked ||
                      !!pending ||
                      pendingProblem ||
                      !approveAll ||
                      !simulationAck ||
                      !codeApproval ||
                      previewContext !== contextKey ||
                      previewExpired ||
                      !canSign?.(view)
                    }
                    onClick={() =>
                      void run(async () => {
                        if (
                          !approveAll ||
                          !simulationAck ||
                          !codeApproval ||
                          !canSign?.(view) ||
                          !onSign
                        )
                          throw new Error('Exact signing consent is required.');
                        const selected = { ...signingState.current };
                        const storedBefore = localStorage.getItem(
                          pendingKey(review.id),
                        );
                        const consent = groupSigningConsent(review);
                        try {
                          const preview = await requirePumpRuntimePreview(
                            runtimePreview,
                            review,
                          );
                          const result = await request('', {
                            action: 'authorize-signing',
                            id: review.id,
                            previewId: preview.id,
                            consent,
                            codeConsent: {
                              approved: true,
                              previewId: preview.id,
                              identitySha256: preview.identitySha256,
                              acknowledgeUpgradeableCode: true,
                              acknowledgeNoSemanticAudit: true,
                            },
                          });
                          if (!record(result)) throw new Error();
                          const approved = await parsePumpGroupView(
                            result.group,
                            projectId,
                            controller.current!.signal,
                          );
                          if (
                            approved.state !== 'approved' ||
                            canonicalPumpHolderJson(approved.review) !==
                              canonicalPumpHolderJson(review)
                          )
                            throw new Error();
                          const returnedPreview =
                            await requirePumpRuntimePreview(
                              result.preview,
                              review,
                              false,
                            );
                          if (
                            canonicalPumpHolderJson(returnedPreview) !==
                            canonicalPumpHolderJson(preview)
                          )
                            throw new Error();
                          const authorization = requirePumpSigningAuthorization(
                            result.authorization,
                            preview,
                            review,
                          );
                          const guard = () => {
                            current();
                            requirePumpSigningAuthorization(
                              authorization,
                              preview,
                              review,
                            );
                            if (
                              canonicalPumpHolderJson(signingState.current) !==
                                canonicalPumpHolderJson(selected) ||
                              localStorage.getItem(pendingKey(review.id)) !==
                                storedBefore
                            )
                              throw new Error('Signing context changed.');
                          };
                          guard();
                          setView(approved);
                          const signingSignal = controller.current!.signal;
                          const signed = await onSign({
                            view: approved,
                            consent,
                            preview,
                            authorization,
                            current: guard,
                            signal: signingSignal,
                          });
                          const verified =
                            await verifyPumpLaunchGroupSignatures(
                              review,
                              signed.packets.map(
                                (packet) => packet.transaction,
                              ),
                              controller.current!.signal,
                            );
                          if (
                            canonicalPumpHolderJson(verified) !==
                            canonicalPumpHolderJson(signed)
                          )
                            throw new Error('Signed group differs.');
                          current();
                          const captured: Pending = {
                            contextSha256: review.contextSha256,
                            transactions: verified.packets.map(
                              (packet) => packet.transaction,
                            ),
                            signedGroupSha256: verified.signedGroupSha256,
                          };
                          setPending(captured);
                          try {
                            localStorage.setItem(
                              pendingKey(review.id),
                              JSON.stringify(captured),
                            );
                          } catch {
                            setNotice(
                              'The complete signed group is in memory. Download it before leaving.',
                            );
                          }
                          await registerRetained(approved, captured);
                        } finally {
                          resetSigning();
                        }
                      })
                    }
                  >
                    Approve and sign complete group locally
                  </Button>
                  {!canSign?.(view) && (
                    <p>
                      Signing needs the exact saved draft and limits, the
                      acknowledged mint backup, and both passphrases above.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          {onSignTip && view.signedEvidence && (
            <PumpGroupBroadcast
              key={review.id}
              group={view}
              contextKey={contextKey}
              disabled={disabled || busy}
              canSignTip={canSignTip}
              onSignTip={onSignTip}
              onBusyChange={broadcastBusyChanged}
              onGroup={setView}
              onPreparedChange={setBroadcastExists}
            />
          )}
          {pending && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => downloadGroup(review, pending)}
            >
              Download complete signed group
            </Button>
          )}
          {pending && view.state === 'approved' && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void run(() => registerRetained(view, pending))}
            >
              Save existing complete signed group
            </Button>
          )}
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
                disabled={locked || broadcastExists}
                onClick={() =>
                  void run(async () => {
                    const result = await parsePumpGroupRecoveryResult(
                      await request('', { action: 'recover', id: review.id }),
                      view,
                      controller.current!.signal,
                    );
                    current();
                    setView(result.group);
                    if (result.observation)
                      setObservations([result.observation]);
                    setObservationCursor(null);
                    await history();
                    setNotice(
                      result.released
                        ? 'Safe terminal group recovery saved. Wallet reservations released; economic settlement remains unverified.'
                        : 'Recovery observation saved. Pending, partial, unknown or unreconciled successful groups retain reservations.',
                    );
                  })
                }
              >
                {broadcastExists
                  ? 'Recover the broadcast including its tip above'
                  : 'Recover group reservations'}
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
