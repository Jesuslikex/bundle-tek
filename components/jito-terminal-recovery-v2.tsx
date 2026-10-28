'use client';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from './ui/button';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import {
  createJitoPacketRecovery,
  JITO_RECOVERY_FILE_MAX_BYTES,
  readJitoPacketRecovery,
} from '@/lib/jito-packet-recovery';
import { readJitoRecoveryLocator } from '@/lib/jito-recovery-locator';
import {
  requireJitoV2Snapshot,
  type JitoV2Snapshot,
} from '@/lib/jito-v2-snapshot';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { withJitoRecoveryJournalLock } from '@/lib/jito-recovery-journal';
import type { JitoBundleManifest } from '@/lib/jito-bundle';
import type {
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';

type TerminalState = 'cancelled' | 'expired' | 'finalized';
type Props = {
  ownerId: string;
  ownerScope: string;
  manifest: JitoBundleManifest;
  packet: number;
  state: TerminalState;
  coordinator: JitoMemorySignatureRecovery;
  disabled: boolean;
  isContextCurrent: () => boolean;
};
type View = { signature: string; saved: boolean; snapshot: JitoV2Snapshot };

/** Local inspection/export only. No journal write, signing, registration,
 * provider call or transaction submission is performed by this component. */
export function JitoTerminalRecoveryV2(props: Props) {
  return (
    <TerminalForContext
      key={JSON.stringify([
        props.ownerId,
        props.ownerScope,
        props.manifest.id,
        props.manifest.sha256,
        props.packet,
        props.state,
      ])}
      {...props}
    />
  );
}
function TerminalForContext({
  ownerId,
  ownerScope,
  manifest,
  packet,
  state,
  coordinator,
  disabled,
  isContextCurrent,
}: Props) {
  const field = useId(),
    mounted = useRef(true),
    epoch = useRef(0),
    running = useRef(false);
  const bytes = useRef<Uint8Array | null>(null),
    abort = useRef<AbortController | null>(null);
  const disabledNow = useRef(disabled),
    verifiedView = useRef<View | null>(null);
  const [selectionGeneration, setSelectionGeneration] = useState(0);
  const selectionGenerationNow = useRef(0);
  useLayoutEffect(() => {
    disabledNow.current = disabled;
  }, [disabled]);
  const [busy, setBusy] = useState(false),
    [view, setView] = useState<View | null>(null),
    [error, setError] = useState('');
  const invalidate = useCallback(() => {
    epoch.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
      abort.current?.abort();
      bytes.current?.fill(0);
      bytes.current = null;
      verifiedView.current = null;
    };
  }, [invalidate]);
  const current = (
    generation: number,
    signal: AbortSignal,
    manifestJson: string,
  ) => {
    signal.throwIfAborted();
    if (
      !mounted.current ||
      epoch.current !== generation ||
      !isContextCurrent() ||
      JSON.stringify(manifest) !== manifestJson
    )
      throw Error('Recovery context changed.');
  };
  async function exact(
    generation: number,
    signal: AbortSignal,
    approved: JitoBundleManifest,
    manifestJson: string,
  ) {
    current(generation, signal, manifestJson);
    const url = `/api/imported-projects/jito-bundles?projectId=${encodeURIComponent(approved.projectId)}&sessionId=${encodeURIComponent(approved.sessionId)}&bundleId=${encodeURIComponent(approved.id)}`;
    const response = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        'x-jito-protocol': '2',
        [JITO_OWNER_SCOPE_HEADER]: ownerScope,
      },
    });
    current(generation, signal, manifestJson);
    if (
      !response.ok ||
      response.headers.get(JITO_OWNER_SCOPE_HEADER) !== ownerScope
    ) {
      void response.body?.cancel().catch(() => {});
      throw Error('Owned terminal bundle unavailable.');
    }
    const raw = await readBoundedPanelJson(response, signal);
    current(generation, signal, manifestJson);
    const snapshot = await requireJitoV2Snapshot(raw, {
      ownerId,
      responseOwnerScope: response.headers.get(JITO_OWNER_SCOPE_HEADER),
      projectId: approved.projectId,
      sessionId: approved.sessionId,
      bundleId: approved.id,
      manifestSha256: approved.sha256,
    });
    current(generation, signal, manifestJson);
    if (snapshot.bundle.state !== state)
      throw Error('Terminal bundle state changed.');
    for (const attempt of snapshot.attempts)
      if (attempt.state === 'registered') {
        const checked = await createJitoPacketRecovery(
          snapshot.bundle.manifest,
          attempt.packet,
          attempt.transaction!,
        );
        current(generation, signal, manifestJson);
        if (checked.signature !== attempt.signature)
          throw Error('Stored receipt differs.');
      }
    return snapshot;
  }
  async function inspect(
    input: Uint8Array,
    generation: number,
    signal: AbortSignal,
    approved: JitoBundleManifest,
    manifestJson: string,
  ) {
    const locator = await readJitoRecoveryLocator(input);
    current(generation, signal, manifestJson);
    if (
      locator.projectId !== approved.projectId ||
      locator.sessionId !== approved.sessionId ||
      locator.bundleId !== approved.id ||
      locator.sha256 !== approved.sha256 ||
      locator.packet !== packet
    )
      throw Error('Recovery file identity differs.');
    const first = await exact(generation, signal, approved, manifestJson);
    const checked = await readJitoPacketRecovery(
      new TextDecoder('utf-8', { fatal: true }).decode(input),
      first.bundle.manifest,
      packet,
    );
    current(generation, signal, manifestJson);
    const saved = first.bundle.signatures[packet];
    if (saved !== null && saved !== checked.signature)
      throw Error('Saved signature differs.');
    const second = await exact(generation, signal, approved, manifestJson);
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw Error('Terminal bundle changed.');
    current(generation, signal, manifestJson);
    return {
      signature: checked.signature,
      saved: saved !== null,
      snapshot: second,
    };
  }
  async function run(file?: File, expectedView?: View) {
    if (
      running.current ||
      disabledNow.current ||
      !mounted.current ||
      !isContextCurrent() ||
      !ownerScope ||
      coordinator.operationActive() ||
      (!file && (!expectedView || verifiedView.current !== expectedView))
    )
      return;
    const manifestJson = JSON.stringify(manifest);
    const approved = JSON.parse(manifestJson) as JitoBundleManifest;
    let operation: JitoOperationToken;
    try {
      if (coordinator.has(ownerScope, manifest.id, packet))
        throw Error('Original signing outcome is pending.');
      operation = coordinator.startOperation(ownerScope);
    } catch {
      setError('Recovery is unavailable while another Jito action is pending.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    const generation = epoch.current,
      controller = new AbortController();
    abort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    let owned: Uint8Array | null = null;
    try {
      if ((await jitoOwnerScope(ownerId)) !== ownerScope)
        throw Error('Account scope differs.');
      current(generation, signal, manifestJson);
      if (file) {
        if (
          !Number.isSafeInteger(file.size) ||
          file.size < 1 ||
          file.size > JITO_RECOVERY_FILE_MAX_BYTES
        )
          throw Error('Recovery file unavailable.');
        const source = await file.arrayBuffer();
        current(generation, signal, manifestJson);
        const length = Object.getOwnPropertyDescriptor(
          ArrayBuffer.prototype,
          'byteLength',
        )!.get!.call(source) as number;
        if (length !== file.size || length > JITO_RECOVERY_FILE_MAX_BYTES)
          throw Error('Recovery file unavailable.');
        owned = new Uint8Array(source).slice();
      } else {
        if (!view || !bytes.current) throw Error('Recovery file unavailable.');
        owned = bytes.current.slice();
      }
      await withJitoRecoveryJournalLock(
        ownerScope,
        () => current(generation, signal, manifestJson),
        async () => {
          const result = await inspect(
            owned!,
            generation,
            signal,
            approved,
            manifestJson,
          );
          current(generation, signal, manifestJson);
          if (file) {
            bytes.current?.fill(0);
            bytes.current = owned;
            owned = null;
            verifiedView.current = result;
            setView(result);
          } else {
            if (
              !view ||
              view.signature !== result.signature ||
              view.saved !== result.saved ||
              JSON.stringify(view.snapshot) !== JSON.stringify(result.snapshot)
            )
              throw Error('Terminal bundle changed.');
            current(generation, signal, manifestJson);
            const url = URL.createObjectURL(
              new Blob([Uint8Array.from(owned!).buffer], {
                type: 'application/json',
              }),
            );
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            const link = document.createElement('a');
            link.href = url;
            link.download = `bundle-${approved.id}-packet-${packet + 1}-recovery.json`;
            current(generation, signal, manifestJson);
            link.click();
          }
        },
      );
    } catch {
      if (mounted.current && isContextCurrent())
        setError(
          'Recovery file or terminal bundle could not be verified. No signing or submission was attempted.',
        );
    } finally {
      owned?.fill(0);
      controller.abort();
      if (abort.current === controller) abort.current = null;
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label={`Terminal recovery for packet ${packet + 1}`}>
      <p>
        Inspect or privately export a signed packet. This never registers, signs
        or submits it. Signed packets may be usable while valid.
      </p>
      <p>
        Cancellation or expiry does not establish whether an earlier signature
        landed. Inspection alone does not prove finality.
      </p>
      <label htmlFor={field}>
        Verify saved recovery file for packet {packet + 1}
      </label>
      <input
        id={field}
        type="file"
        accept="application/json,.json"
        disabled={busy || disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (
            file &&
            selectionGeneration === selectionGenerationNow.current &&
            mounted.current &&
            !running.current &&
            !disabledNow.current &&
            isContextCurrent() &&
            ownerScope
          ) {
            if (coordinator.operationActive()) {
              setError(
                'Recovery is unavailable while another Jito action is pending.',
              );
              return;
            }
            selectionGenerationNow.current++;
            setSelectionGeneration(selectionGenerationNow.current);
            event.target.value = '';
            bytes.current?.fill(0);
            bytes.current = null;
            verifiedView.current = null;
            setView(null);
            void run(file);
          }
        }}
      />
      {view && (
        <>
          <p>
            Exact signed packet verified for this saved bundle.{' '}
            {view.saved
              ? 'Its signature matches the saved record.'
              : 'Its signature is not recorded here; that does not establish its chain outcome.'}
          </p>
          {view.snapshot.legacyReadOnly && (
            <p>This legacy bundle is read-only.</p>
          )}
          {state === 'finalized' && !view.snapshot.bundle.finalization && (
            <p>
              The historical finalization receipt was not retained; this
              inspection does not establish finality.
            </p>
          )}
          <Button
            variant="outline"
            disabled={busy || disabled}
            onClick={() => void run(undefined, view)}
          >
            Download verified packet privately
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
