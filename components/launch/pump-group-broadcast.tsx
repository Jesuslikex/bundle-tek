'use client';
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useId,
} from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readPanelJson } from '@/components/read-panel-json';
import {
  parsePumpGroupView,
  type PumpGroupView,
} from '@/lib/pump-launch-group-client';
import {
  parsePumpGroupBroadcastState,
  type PumpGroupTipSignAction,
} from '@/lib/pump-group-broadcast-client';
import {
  verifyPumpGroupTip,
  type PumpGroupBroadcastState,
  type PumpGroupBroadcastTip,
} from '@/lib/pump-group-broadcast';
import { canonicalPumpHolderJson } from '@/lib/pump-holder-review';
import { holderDisplayRaw } from '@/lib/pump-holder-launch-client';
import styles from './pump-launch-group-ui.module.css';
import {
  parsePumpGroupChainEffects,
  type PumpGroupChainEffects,
} from '@/lib/pump-group-chain-effects';
import { PumpGroupChainEffectsPanel } from './pump-group-chain-effects-panel';
import { usePumpTokenWorkspaceNavigation } from './pump-token-workspace-navigation';
import {
  parsePumpLaunchTokenWorkspace,
  pumpLaunchWorkspaceReady,
} from '@/lib/pump-launch-token-workspace';
type Props = {
  group: PumpGroupView;
  contextKey: string;
  disabled?: boolean;
  canSignTip?: boolean;
  onSignTip?: PumpGroupTipSignAction;
  onBusyChange?: (v: boolean) => void;
  onGroup: (g: PumpGroupView) => void;
  onPreparedChange?: (value: boolean) => void;
};
const storageKey = (id: string) => 'bundle.pump-group-tip.v1:' + id;
const decodeBody = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function downloadTip(
  state: PumpGroupBroadcastState,
  tip: PumpGroupBroadcastTip,
) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ review: state.review, tip })], {
      type: 'application/json',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bundle-group-tip-' + state.review.id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function PumpGroupBroadcast({
  group,
  contextKey,
  disabled = false,
  canSignTip = false,
  onSignTip,
  onBusyChange,
  onGroup,
  onPreparedChange,
}: Props) {
  const id = useId();
  const openTokenWorkspace = usePumpTokenWorkspaceNavigation();
  const [state, setState] = useState<PumpGroupBroadcastState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [tipRaw, setTipRaw] = useState('1000'),
    [feeRaw, setFeeRaw] = useState('5000'),
    [tipApproval, setTipApproval] = useState(false),
    [broadcastApproval, setBroadcastApproval] = useState(false);
  const [pending, setPending] = useState<PumpGroupBroadcastTip | null>(null),
    [storageProblem, setStorageProblem] = useState(false);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [walletResults, setWalletResults] = useState<{
    contextKey: string;
    report: PumpGroupChainEffects;
  } | null>(null);
  const context = useRef(contextKey),
    active = useRef(true),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    context.current = contextKey;
  }, [contextKey]);
  const current = () => {
    if (!active.current || controller.current?.signal.aborted)
      throw new Error('Broadcast context changed.');
  };
  const request = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/launch/pump/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.current!.signal,
      body: JSON.stringify({ ...body, id: group.review.id }),
    });
    current();
    if (!response.ok && body.action === 'token-workspace')
      throw new Error(
        response.status === 429
          ? 'Wait five seconds before opening this token workspace again.'
          : 'Token workspace opening did not finish. It may already have been saved; retry this same finalized group to recover it.',
      );
    if (!response.ok && body.action === 'chain-effects')
      throw new Error(
        'Finalized wallet results are unavailable. Retained signatures and reservations were not changed; retry this read after checking saved history.',
      );
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? 'Wait five seconds before repeating this broadcast action.'
          : 'Group broadcast service could not accept the saved scope. Reload saved broadcast and retain any signed tip; an attempted send must be recovered, never retried.',
      );
    return readPanelJson(response, 'Group broadcast response is unavailable.');
  };
  async function capture(value: unknown, view = group) {
    const checked = await parsePumpGroupBroadcastState(value, view);
    current();
    setState(checked);
    onPreparedChange?.(!!checked);
    setSendUncertain(false);
    if (!checked) {
      setPending(null);
      setStorageProblem(false);
      return;
    }
    if (checked.tip) {
      setPending(checked.tip);
      setStorageProblem(false);
      return;
    }
    try {
      const retained = localStorage.getItem(storageKey(checked.review.id));
      if (!retained) {
        setPending(null);
        setStorageProblem(false);
        return;
      }
      if (retained.length > 1200) throw new Error();
      const candidate = JSON.parse(retained) as {
        reviewSha256: string;
        tip: PumpGroupBroadcastTip;
      };
      if (candidate.reviewSha256 !== checked.review.sha256) throw new Error();
      const tip = await verifyPumpGroupTip(
        checked.review,
        candidate.tip.transaction,
      );
      if (
        canonicalPumpHolderJson(tip) !== canonicalPumpHolderJson(candidate.tip)
      )
        throw new Error();
      current();
      setPending(tip);
      setStorageProblem(false);
    } catch {
      setPending(null);
      setStorageProblem(true);
      setNotice(
        'The browser tip backup cannot be verified. Keep the original file and recover this group after expiry. Signing is blocked to preserve its history.',
      );
    }
  }
  async function run(task: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true;
    controller.current = new AbortController();
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error &&
            /^(Wait five|Group broadcast|Finalized wallet|Token workspace)/.test(
              e.message,
            )
            ? e.message
            : 'Broadcast action did not complete. Keep retained signatures and reload the saved broadcast before continuing.',
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
  const load = useEffectEvent(
    () =>
      void run(async () =>
        capture(await request({ action: 'broadcast-read' })),
      ),
  );
  useEffect(() => {
    if (disabled) return;
    const timer = setTimeout(() => load(), 0);
    return () => clearTimeout(timer);
  }, [disabled]);
  const locked = disabled || busy;
  return (
    <section
      className={styles.panel}
      aria-label="User-approved group Jito broadcast"
    >
      <h4>Broadcast the complete group through Jito</h4>
      <p>
        The launch packets stay unchanged. A separately approved tip is the
        final packet. This supports up to four launch packets plus one tip. A
        consumed send attempt is never sent again by this app.
      </p>
      {group.review.packets.length > 4 && (
        <output>
          This group has five launch packets. It cannot fit an additional
          reviewed tip in Jito’s five-packet limit. Nothing will be dropped or
          sent separately.
        </output>
      )}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() =>
            void run(async () =>
              capture(await request({ action: 'broadcast-read' })),
            )
          }
        >
          Reload saved broadcast
        </Button>
      </div>
      {!state &&
        group.state === 'signed' &&
        group.review.packets.length <= 4 && (
          <>
            <label htmlFor={id + '-tip'}>
              Jito tip in lamports (1 SOL = 1,000,000,000 lamports)
              <Input
                id={id + '-tip'}
                value={tipRaw}
                inputMode="numeric"
                disabled={locked}
                onChange={(e) => setTipRaw(e.target.value)}
              />
            </label>
            <label htmlFor={id + '-fee'}>
              Additional tip transaction network-fee cap in lamports
              <Input
                id={id + '-fee'}
                value={feeRaw}
                inputMode="numeric"
                disabled={locked}
                onChange={(e) => setFeeRaw(e.target.value)}
              />
            </label>
            <Button
              type="button"
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  setTipApproval(false);
                  setBroadcastApproval(false);
                  await capture(
                    await request({
                      action: 'broadcast-prepare',
                      tipRaw,
                      tipFeeLimitRaw: feeRaw,
                    }),
                  );
                })
              }
            >
              Review complete broadcast and tip costs
            </Button>
          </>
        )}
      {state && (
        <>
          <p>
            {state.review.transactions.length + 1} ordered packets. Tip:{' '}
            {holderDisplayRaw(state.review.tipRaw, 9)} SOL. Additional network
            fee cap: {holderDisplayRaw(state.review.tipFeeLimitRaw, 9)} SOL.
            These costs are added to the existing launch caps.
          </p>
          <p>
            Tip recipient: <code>{state.review.recipient}</code>. Original
            lifetime: block height {state.review.lastValidBlockHeight}.
          </p>
          <p>
            Jito is asked to execute the complete bundle atomically. Simulation
            and a bundle ID do not prove inclusion or atomicity. Signed packets
            may be submitted outside this app. Recovery checks their exact
            finalized chain bytes. The separate signed tip can also land
            independently if it is rebroadcast. Partial outcomes retain
            reservations until every packet and the tip have finalized with
            known fees or provably expired.
          </p>
          {state.attempted || sendUncertain ? (
            <output>
              {state.attempted
                ? 'One send attempt has been consumed.'
                : 'A broadcast approval request was sent. Delivery has not been confirmed; reload its saved attempt status.'}{' '}
              {state.result?.bundleId ? (
                <>
                  Provider acknowledgement: <code>{state.result.bundleId}</code>
                  .
                </>
              ) : (
                'Its outcome is uncertain, including a possible crash before delivery.'
              )}{' '}
              Use recovery; no resend is available.
            </output>
          ) : (
            <>
              {!pending && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={tipApproval}
                      disabled={locked || storageProblem}
                      onChange={(e) => setTipApproval(e.target.checked)}
                    />{' '}
                    I approve signing this exact tip and its additional fee cap
                    from the group payer.
                  </label>
                  <Button
                    type="button"
                    disabled={
                      locked ||
                      storageProblem ||
                      !tipApproval ||
                      !canSignTip ||
                      !onSignTip
                    }
                    onClick={() =>
                      void run(async () => {
                        if (
                          !tipApproval ||
                          !onSignTip ||
                          !canSignTip ||
                          state.attempted
                        )
                          throw new Error('Explicit tip approval is required.');
                        const selected = context.current,
                          stored = localStorage.getItem(
                            storageKey(state.review.id),
                          );
                        const guard = () => {
                          current();
                          if (
                            context.current !== selected ||
                            localStorage.getItem(
                              storageKey(state.review.id),
                            ) !== stored
                          )
                            throw new Error('Tip scope changed.');
                        };
                        try {
                          guard();
                          const signed = await onSignTip(
                            state.review,
                            group,
                            guard,
                            controller.current!.signal,
                          );
                          const checked = await verifyPumpGroupTip(
                            state.review,
                            signed.transaction,
                          );
                          current();
                          setPending(checked);
                          try {
                            localStorage.setItem(
                              storageKey(state.review.id),
                              JSON.stringify({
                                reviewSha256: state.review.sha256,
                                tip: checked,
                              }),
                            );
                          } catch {
                            setNotice(
                              'The signed tip is retained in memory. Download it before leaving.',
                            );
                          }
                          await capture(
                            await request({
                              action: 'broadcast-register-tip',
                              broadcastId: state.review.id,
                              sha256: state.review.sha256,
                              transaction: checked.transaction,
                            }),
                          );
                        } finally {
                          setTipApproval(false);
                          setBroadcastApproval(false);
                        }
                      })
                    }
                  >
                    Approve and sign the reviewed tip locally
                  </Button>
                  {!canSignTip && (
                    <p>
                      Enter the wallet vault passphrase above and restore the
                      exact saved group draft and limits before signing the tip.
                    </p>
                  )}
                </>
              )}
              {pending && !state.tip && (
                <Button
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void run(async () =>
                      capture(
                        await request({
                          action: 'broadcast-register-tip',
                          broadcastId: state.review.id,
                          sha256: state.review.sha256,
                          transaction: pending.transaction,
                        }),
                      ),
                    )
                  }
                >
                  Save existing signed tip without resigning
                </Button>
              )}
              {state.tip && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={broadcastApproval}
                      disabled={locked}
                      onChange={(e) => setBroadcastApproval(e.target.checked)}
                    />{' '}
                    I approve one broadcast attempt of every reviewed launch
                    packet and this signed tip. A lost response can mean
                    delivery; do not resend.
                  </label>
                  <Button
                    type="button"
                    disabled={
                      locked || !broadcastApproval || group.state !== 'signed'
                    }
                    onClick={() =>
                      void run(async () => {
                        if (!broadcastApproval || state.attempted)
                          throw new Error(
                            'Explicit broadcast approval is required.',
                          );
                        setSendUncertain(true);
                        try {
                          await capture(
                            await request({
                              action: 'broadcast-submit',
                              consent: {
                                approved: true,
                                reviewId: group.review.id,
                                broadcastId: state.review.id,
                                broadcastSha256: state.review.sha256,
                                signedGroupSha256:
                                  state.review.signedGroupSha256,
                                scope:
                                  'one-attempt-jito-complete-group-and-tip',
                                acknowledgeUncertainOutcome: true,
                              },
                            }),
                          );
                        } finally {
                          setBroadcastApproval(false);
                        }
                      })
                    }
                  >
                    Broadcast this complete group once
                  </Button>
                </>
              )}
            </>
          )}
          {storageProblem && !state.tip && !state.attempted && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  localStorage.removeItem(storageKey(state.review.id));
                  setPending(null);
                  setStorageProblem(false);
                  setTipApproval(false);
                  setBroadcastApproval(false);
                  setNotice(
                    'The corrupt local backup was discarded. The reviewed tip message is unchanged. Explicit approval is required to sign it again.',
                  );
                })
              }
            >
              Discard corrupt local tip backup
            </Button>
          )}
          {!state.attempted && !state.tip && (
            <label htmlFor={id + '-restore-tip'}>
              Restore the original signed tip file for registration and recovery
              <Input
                id={id + '-restore-tip'}
                type="file"
                accept="application/json,.json"
                disabled={locked}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  void run(async () => {
                    if (file.size > 32768)
                      throw new Error('Tip recovery file is too large.');
                    const selected = context.current,
                      result: unknown = JSON.parse(await file.text());
                    if (
                      !decodeBody(result) ||
                      canonicalPumpHolderJson(result.review) !==
                        canonicalPumpHolderJson(state.review) ||
                      !decodeBody(result.tip) ||
                      typeof result.tip.transaction !== 'string'
                    )
                      throw new Error('Tip recovery scope differs.');
                    const checked = await verifyPumpGroupTip(
                      state.review,
                      result.tip.transaction,
                    );
                    current();
                    if (context.current !== selected)
                      throw new Error('Recovery context changed.');
                    setPending(checked);
                    setStorageProblem(false);
                    setTipApproval(false);
                    setBroadcastApproval(false);
                    try {
                      localStorage.setItem(
                        storageKey(state.review.id),
                        JSON.stringify({
                          reviewSha256: state.review.sha256,
                          tip: checked,
                        }),
                      );
                    } catch {
                      setNotice(
                        'Restored signed tip retained in memory; save its existing bytes before leaving.',
                      );
                    }
                  });
                }}
              />
            </label>
          )}
          {pending && (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => downloadTip(state, pending)}
            >
              Download retained signed tip
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void run(async () => {
                const result = await request({ action: 'broadcast-recover' });
                if (!decodeBody(result)) throw new Error();
                const checked = await parsePumpGroupView(
                  result.group,
                  group.review.projectId,
                  controller.current!.signal,
                );
                await capture(result.broadcast, checked);
                current();
                onGroup(checked);
              })
            }
          >
            Recover complete broadcast including tip
          </Button>
          {state.recovery && (
            <output>
              Observed outcome:{' '}
              {state.recovery.state === 'partial-final'
                ? 'settled partial (nothing further can land)'
                : state.recovery.state}
              . Tip network fee:{' '}
              {state.recovery.tip.networkFeeRaw === null
                ? 'unresolved'
                : holderDisplayRaw(state.recovery.tip.networkFeeRaw, 9) +
                  ' SOL'}
              . Tip debit:{' '}
              {state.recovery.tip.tipDebitRaw === null
                ? 'unresolved'
                : holderDisplayRaw(state.recovery.tip.tipDebitRaw, 9) + ' SOL'}
              .{' '}
              {state.reservationsReleased
                ? 'Pending execution reservations released.'
                : 'Reservations remain held.'}{' '}
              Economic settlement and atomicity are not independently
              established.
            </output>
          )}
        </>
      )}
      {openTokenWorkspace && pumpLaunchWorkspaceReady(group) && (
        <div className={styles.actions}>
          <Button
            type="button"
            disabled={locked}
            onClick={() =>
              void run(async () => {
                const selected = context.current;
                const result = parsePumpLaunchTokenWorkspace(
                  await request({ action: 'token-workspace' }),
                  group,
                );
                current();
                if (selected !== context.current)
                  throw new Error(
                    'Token workspace context changed. Reopen the current saved group.',
                  );
                setNotice(
                  result.project.archived
                    ? 'The existing workspace is archived. Restore it explicitly there before making changes.'
                    : 'Token workspace ready. Market data may take time to index; trading still needs separate review and approval.',
                );
                openTokenWorkspace(result.project);
              })
            }
          >
            Open token workspace and chart
          </Button>
        </div>
      )}
      {group.signedEvidence && (
        <PumpGroupChainEffectsPanel
          disabled={!!locked}
          report={
            walletResults?.contextKey === contextKey &&
            walletResults.report.reviewId === group.review.id &&
            walletResults.report.signedGroupSha256 ===
              group.signedEvidence.signedGroupSha256
              ? walletResults.report
              : null
          }
          onRead={() =>
            void run(async () => {
              const selected = context.current;
              setWalletResults(null);
              const report = await parsePumpGroupChainEffects(
                await request({ action: 'chain-effects' }),
                group,
              );
              current();
              if (selected !== context.current)
                throw new Error(
                  'Finalized wallet result context changed. Read the current saved group again.',
                );
              setWalletResults({ contextKey: selected, report });
            })
          }
        />
      )}
      {busy && <output>Checking complete broadcast...</output>}
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
