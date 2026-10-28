'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import {
  JITO_RECOVERY_FILE_MAX_BYTES,
  createJitoPacketRecovery,
  readJitoPacketRecovery,
} from '@/lib/jito-packet-recovery';
import {
  readJitoRecoveryLocator,
  type JitoRecoveryLocator,
} from '@/lib/jito-recovery-locator';
import {
  requireJitoV2Snapshot,
  type JitoV2Snapshot,
} from '@/lib/jito-v2-snapshot';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { withJitoRecoveryJournalLock } from '@/lib/jito-recovery-journal';
import type {
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';

type Props = {
  ownerId: string;
  ownerScope: string;
  projectId: string;
  sessionId: string;
  coordinator: JitoMemorySignatureRecovery;
  disabled: boolean;
  isContextCurrent: () => boolean;
  /** Open only the already validated record. Caller must preserve its legacy
   * read-only state and independently recheck before any later mutation. */
  onOpen: (value: {
    locator: JitoRecoveryLocator;
    snapshot: JitoV2Snapshot;
  }) => void;
};
type View = {
  locator: JitoRecoveryLocator;
  signature: string;
  snapshot: JitoV2Snapshot;
};

export function JitoRecoveryLocatorV2(props: Props) {
  return (
    <JitoRecoveryLocatorV2ForContext
      key={JSON.stringify([
        props.ownerId,
        props.ownerScope,
        props.projectId,
        props.sessionId,
      ])}
      {...props}
    />
  );
}

function JitoRecoveryLocatorV2ForContext({
  ownerId,
  ownerScope,
  projectId,
  sessionId,
  coordinator,
  disabled,
  isContextCurrent,
  onOpen,
}: Props) {
  const field = useId(),
    mounted = useRef(true),
    epoch = useRef(0),
    running = useRef(false);
  const ownedFile = useRef<Uint8Array | null>(null),
    controller = useRef<AbortController | null>(null);
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
      controller.current?.abort();
      ownedFile.current?.fill(0);
      ownedFile.current = null;
    };
  }, [invalidate]);
  const assertCurrent = (generation: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!mounted.current || epoch.current !== generation || !isContextCurrent())
      throw Error('Recovery context changed.');
  };
  async function exact(
    locator: JitoRecoveryLocator,
    signal: AbortSignal,
    generation: number,
  ) {
    assertCurrent(generation, signal);
    const url = `/api/imported-projects/jito-bundles?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}&bundleId=${encodeURIComponent(locator.bundleId)}`;
    const response = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        [JITO_OWNER_SCOPE_HEADER]: ownerScope,
        'x-jito-protocol': '2',
      },
    });
    assertCurrent(generation, signal);
    if (
      !response.ok ||
      response.headers.get(JITO_OWNER_SCOPE_HEADER) !== ownerScope
    ) {
      void response.body?.cancel().catch(() => {});
      throw Error('Owned recovery record unavailable.');
    }
    const value = await readBoundedPanelJson(response, signal);
    assertCurrent(generation, signal);
    const snapshot = await requireJitoV2Snapshot(value, {
      ownerId,
      responseOwnerScope: response.headers.get(JITO_OWNER_SCOPE_HEADER),
      projectId,
      sessionId,
      bundleId: locator.bundleId,
      manifestSha256: locator.sha256,
    });
    assertCurrent(generation, signal);
    for (const attempt of snapshot.attempts)
      if (attempt.state === 'registered') {
        const checked = await createJitoPacketRecovery(
          snapshot.bundle.manifest,
          attempt.packet,
          attempt.transaction!,
        );
        assertCurrent(generation, signal);
        if (checked.signature !== attempt.signature)
          throw Error('Recovery receipt differs.');
      }
    assertCurrent(generation, signal);
    return snapshot;
  }
  async function validate(
    bytes: Uint8Array,
    signal: AbortSignal,
    generation: number,
  ) {
    const locator = await readJitoRecoveryLocator(bytes);
    assertCurrent(generation, signal);
    if (locator.projectId !== projectId || locator.sessionId !== sessionId)
      throw Error('Recovery file belongs to another project or session.');
    const first = await exact(locator, signal, generation);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const packet = await readJitoPacketRecovery(
      text,
      first.bundle.manifest,
      locator.packet,
    );
    assertCurrent(generation, signal);
    const saved = first.bundle.signatures[locator.packet];
    if (saved !== null && saved !== packet.signature)
      throw Error('Recovery signature differs.');
    if (!first.legacyReadOnly) {
      const attempt = first.attempts.find(
        (item) => item.packet === locator.packet,
      );
      if (
        !attempt ||
        (attempt.state === 'registered' &&
          (attempt.signature !== packet.signature ||
            attempt.transaction !== packet.transaction))
      )
        throw Error('Exact signing attempt unavailable.');
    }
    const second = await exact(locator, signal, generation);
    if (JSON.stringify(second) !== JSON.stringify(first))
      throw Error('Recovery record changed.');
    assertCurrent(generation, signal);
    return { locator, signature: packet.signature, snapshot: second };
  }
  async function perform(file?: File) {
    if (running.current || disabled || !ownerScope) return;
    let operation: JitoOperationToken;
    try {
      operation = coordinator.startOperation(ownerScope);
    } catch {
      setError('Another Jito action is in progress.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    const generation = epoch.current,
      abort = new AbortController();
    controller.current = abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    let next: Uint8Array | null = null;
    try {
      if ((await jitoOwnerScope(ownerId)) !== ownerScope)
        throw Error('Account scope differs.');
      assertCurrent(generation, signal);
      if (file) {
        if (
          !Number.isSafeInteger(file.size) ||
          file.size < 1 ||
          file.size > JITO_RECOVERY_FILE_MAX_BYTES
        )
          throw Error('Recovery file unavailable.');
        const source = await file.arrayBuffer();
        assertCurrent(generation, signal);
        const length = Object.getOwnPropertyDescriptor(
          ArrayBuffer.prototype,
          'byteLength',
        )!.get!.call(source) as number;
        if (length !== file.size || length > JITO_RECOVERY_FILE_MAX_BYTES)
          throw Error('Recovery file unavailable.');
        next = new Uint8Array(source).slice();
      } else {
        if (!view || !ownedFile.current)
          throw Error('Recovery file unavailable.');
        next = ownedFile.current.slice();
      }
      const result = await withJitoRecoveryJournalLock(
        ownerScope,
        () => assertCurrent(generation, signal),
        () => validate(next!, signal, generation),
      );
      assertCurrent(generation, signal);
      if (file) {
        ownedFile.current?.fill(0);
        ownedFile.current = next;
        next = null;
        setView(result);
      } else {
        if (
          !view ||
          result.locator.bundleId !== view.locator.bundleId ||
          result.locator.sha256 !== view.locator.sha256 ||
          result.locator.packet !== view.locator.packet ||
          result.signature !== view.signature ||
          JSON.stringify(result.snapshot) !== JSON.stringify(view.snapshot)
        )
          throw Error('Recovery record changed.');
        assertCurrent(generation, signal);
        onOpen({ locator: result.locator, snapshot: result.snapshot });
        assertCurrent(generation, signal);
        ownedFile.current?.fill(0);
        ownedFile.current = null;
        setView(null);
      }
    } catch {
      if (mounted.current && isContextCurrent())
        setError(
          'Recovery file or owned bundle could not be verified. No signing or submission was attempted.',
        );
    } finally {
      next?.fill(0);
      abort.abort();
      if (controller.current === abort) controller.current = null;
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Find an older Jito bundle">
      <p>
        Find a saved bundle using its signed recovery file. The file stays in
        this browser; only the bundle, project and session IDs are sent. This
        does not sign, register or submit.
      </p>
      <label htmlFor={field}>Signed packet recovery file</label>
      <input
        id={field}
        type="file"
        accept="application/json,.json"
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            ownedFile.current?.fill(0);
            ownedFile.current = null;
            setView(null);
            void perform(file);
          }
        }}
      />
      {view && (
        <>
          <p>
            Owned bundle <code>{view.locator.bundleId}</code>, packet{' '}
            {view.locator.packet + 1}, verified signature{' '}
            <code>{view.signature}</code>.
          </p>
          {view.snapshot.legacyReadOnly && (
            <p>
              This legacy bundle is read-only; its signing outcome may be
              unknown.
            </p>
          )}
          <Button
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void perform()}
          >
            Open original bundle
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
