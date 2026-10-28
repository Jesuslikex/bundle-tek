import fixture from '@jito-synthetic-vector';
import {
  requireFreshSyntheticOrigin,
  requireOwnedSyntheticJournal,
} from './origin-guard';
declare const __JITO_SYNTHETIC_RUN_ID__: string;
import { bundleFingerprint } from '../../lib/jito-bundle';
import {
  createVault,
  encryptVault,
  unlockVault,
} from '../../lib/browser-wallet-vault';
import {
  createJitoPacketRecovery,
  readJitoPacketRecovery,
} from '../../lib/jito-packet-recovery';
import {
  withJitoRecoveryJournalLock,
  reserveJitoRecoveryUnknown,
  retainJitoRecoverySignature,
  inspectJitoRecoveryJournal,
  acknowledgeJitoRecoveryRegistered,
  reserveJitoImportedEvidence,
} from '../../lib/jito-recovery-journal';

// All material below is a public, already-signed synthetic fixture. No wallet,
// signer, external HTTP request, or chain operation is involved.
const owner = 'a'.repeat(64),
  password = 'synthetic-old-password',
  nextPassword = 'synthetic-new-password';
const status = document.querySelector<HTMLOutputElement>('#status')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const check = (condition: unknown, reason: string) => {
  if (!condition) throw Error(reason);
};
const expectFailure = async (
  operation: () => Promise<unknown>,
  reason: string,
) => {
  try {
    await operation();
  } catch {
    return;
  }
  throw Error(reason);
};
const guard = () => {};
const snapshot = (
  manifest: typeof fixture.manifest,
  signature: string | null = null,
) => ({
  ownerScope: owner,
  record: {
    manifest,
    state: 'reviewed' as const,
    bundleId: null,
    signatures: [signature, null],
    updatedAt: manifest.createdAt,
  },
});
const deleteJournal = async () => {
  if (typeof indexedDB.databases !== 'function')
    throw Error('Database inventory unavailable.');
  requireOwnedSyntheticJournal(location.hostname, await indexedDB.databases());
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(
      'pulseforge.jito-recovery-journal.v1',
    );
    request.onsuccess = () => resolve();
    request.onerror = () => reject(Error('test database deletion failed'));
    request.onblocked = () => reject(Error('test database deletion blocked'));
  });
};
async function lockPeer() {
  const iframe = document.createElement('iframe');
  iframe.src = '/peer.html';
  iframe.title = 'Synthetic lock peer';
  (document.querySelector('body') as HTMLBodyElement).appendChild(iframe);
  await new Promise<void>((resolve, reject) => {
    iframe.onload = () => resolve();
    iframe.onerror = () => reject(Error('peer unavailable'));
  });
  const peerLocks = iframe.contentWindow!.navigator.locks;
  const ask = async () => {
    let acquired = false;
    await peerLocks.request(
      'jito-browser-test-owner-lock',
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        acquired = Boolean(lock);
      },
    );
    return acquired;
  };
  await navigator.locks.request('jito-browser-test-owner-lock', async () => {
    check(!(await ask()), 'competing document acquired held lock');
  });
  check(await ask(), 'peer did not acquire released lock');
  iframe.remove();
}
async function initialize() {
  check(
    isSecureContext && Boolean(navigator.locks) && Boolean(indexedDB),
    'secure IndexedDB and Web Locks required',
  );
  if (typeof indexedDB.databases !== 'function')
    throw Error('Database inventory unavailable.');
  requireFreshSyntheticOrigin(location.hostname, await indexedDB.databases());
  const initial = structuredClone(fixture.manifest);
  const now = Date.now(),
    preparedAt = new Date(now).toISOString(),
    expiresAt = new Date(now + 59000).toISOString();
  const { sha256: _oldDigest, ...base } = initial;
  const terms = {
    ...base,
    createdAt: preparedAt,
    expiresAt,
    swaps: base.swaps.map((review) => ({ ...review, expiresAt })),
    tip: { ...base.tip, preparedAt, expiresAt },
  };
  const manifest = { ...terms, sha256: await bundleFingerprint(terms) };
  const signed = fixture.signed;
  const exact = await createJitoPacketRecovery(manifest, 0, signed);
  const readFresh = async () => snapshot(manifest);
  await withJitoRecoveryJournalLock(owner, guard, async (lock) => {
    const token = await reserveJitoRecoveryUnknown(
      lock,
      manifest,
      0,
      password,
      readFresh,
    );
    const before = await inspectJitoRecoveryJournal(
      lock,
      manifest,
      0,
      password,
      readFresh,
    );
    check(before.status === 'unknown', 'UNKNOWN marker not retained');
    await retainJitoRecoverySignature(lock, token, manifest, signed);
  });
  await lockPeer();
  sessionStorage.setItem(
    'jito-synthetic-test',
    JSON.stringify({ manifest, exact, runId: __JITO_SYNTHETIC_RUN_ID__ }),
  );
  location.reload();
}
async function afterReload(data: {
  manifest: typeof fixture.manifest;
  exact: Awaited<ReturnType<typeof createJitoPacketRecovery>>;
}) {
  const { manifest, exact } = data,
    readFresh = async () => snapshot(manifest);
  await withJitoRecoveryJournalLock(owner, guard, async (lock) => {
    const retained = await inspectJitoRecoveryJournal(
      lock,
      manifest,
      0,
      password,
      readFresh,
    );
    check(
      retained.status === 'retained' &&
        retained.transaction === exact.transaction,
      'retained packet changed after reload',
    );
  });
  await expectFailure(
    () =>
      withJitoRecoveryJournalLock(owner, guard, (lock) =>
        inspectJitoRecoveryJournal(lock, manifest, 0, nextPassword, readFresh),
      ),
    'new password opened old ciphertext',
  );
  await expectFailure(
    () =>
      withJitoRecoveryJournalLock(owner, guard, (lock) =>
        acknowledgeJitoRecoveryRegistered(
          lock,
          manifest,
          0,
          password,
          readFresh,
        ),
      ),
    'unregistered packet acknowledged',
  );
  // Synthetic empty vault envelope rotation is separate from journal encryption.
  const old = await createVault(password),
    oldEnvelope = await encryptVault(old);
  const replacement = await createVault(nextPassword),
    newEnvelope = await encryptVault(replacement);
  await unlockVault(oldEnvelope, password);
  await unlockVault(newEnvelope, nextPassword);
  await expectFailure(
    () => unlockVault(newEnvelope, password),
    'old password opened replacement vault',
  );
  const fileText = JSON.stringify(exact);
  await deleteJournal();
  await withJitoRecoveryJournalLock(owner, guard, async (lock) => {
    const absent = await inspectJitoRecoveryJournal(
      lock,
      manifest,
      0,
      password,
      readFresh,
    );
    check(absent.status === 'not-found', 'storage deletion not observed');
    // The mock server attempt remains UNKNOWN. Absence gives no signing authority.
    const verified = await readJitoPacketRecovery(fileText, manifest, 0);
    await expectFailure(
      () =>
        readJitoPacketRecovery(
          JSON.stringify({ ...exact, signature: 'wrong' }),
          manifest,
          0,
        ),
      'tampered file accepted',
    );
    const attempt = {
      bundleId: manifest.id,
      manifestSha256: manifest.sha256,
      packet: 0,
      signer: manifest.swaps[0].wallet,
      intentId: manifest.swaps[0].id,
      attemptId: '11111111-1111-4111-8111-111111111111',
      state: 'unknown' as const,
      signature: null,
      transaction: null,
    };
    const readEvidence = async () => ({ ...snapshot(manifest), attempt });
    const token = await reserveJitoImportedEvidence(
      lock,
      manifest,
      0,
      nextPassword,
      verified.transaction,
      attempt.attemptId,
      readEvidence,
    );
    await retainJitoRecoverySignature(
      lock,
      token,
      manifest,
      verified.transaction,
    );
    const restored = await inspectJitoRecoveryJournal(
      lock,
      manifest,
      0,
      nextPassword,
      readFresh,
    );
    check(
      restored.status === 'retained' && restored.signature === exact.signature,
      'exact file fallback differs',
    );
  });
  await expectFailure(
    () =>
      withJitoRecoveryJournalLock(owner, guard, (lock) =>
        acknowledgeJitoRecoveryRegistered(
          lock,
          manifest,
          0,
          nextPassword,
          readFresh,
        ),
      ),
    'UNKNOWN evidence acknowledged',
  );
  await withJitoRecoveryJournalLock(owner, guard, (lock) =>
    acknowledgeJitoRecoveryRegistered(
      lock,
      manifest,
      0,
      nextPassword,
      async () => snapshot(manifest, exact.signature),
    ),
  );
  await withJitoRecoveryJournalLock(owner, guard, async (lock) => {
    const gone = await inspectJitoRecoveryJournal(
      lock,
      manifest,
      0,
      nextPassword,
      async () => snapshot(manifest, exact.signature),
    );
    check(
      gone.status === 'not-found',
      'matching receipt did not acknowledge retained record',
    );
  });
  sessionStorage.removeItem('jito-synthetic-test');
}
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Running synthetic checks…';
  try {
    await initialize();
  } catch (error) {
    status.textContent = `FAILED: ${error instanceof Error ? error.message : 'unknown'}`;
    button.disabled = false;
  }
});
const previous = sessionStorage.getItem('jito-synthetic-test');
if (previous) {
  button.disabled = true;
  status.textContent = 'Checking reload and recovery…';
  const resumed = JSON.parse(previous);
  if (resumed.runId !== __JITO_SYNTHETIC_RUN_ID__)
    throw Error('Synthetic run identity differs.');
  void afterReload(resumed)
    .then(() => {
      status.textContent =
        'PASS: IndexedDB reload, synthetic-name Web Locks contention with a same-origin iframe, old/new password comparison, controlled storage loss, exact synthetic file fallback and matching mock receipt. This is not a two-tab or app-UI test; no real wallet, provider or transaction submission was used.';
    })
    .catch((error) => {
      status.textContent = `FAILED: ${error instanceof Error ? error.message : 'unknown'}`;
    });
}
