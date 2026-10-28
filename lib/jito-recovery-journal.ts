import bs58 from 'bs58';
import {
  requireJitoManifest,
  type JitoBundleManifest,
  type JitoBundleRecord,
} from './jito-bundle';
import { createJitoPacketRecovery } from './jito-packet-recovery';
import {
  deleteRetainedJournalEntry,
  insertJournalUnknown,
  listJournalEntries,
  readJournalEntry,
  retainJournalEntry,
  type JournalEntry,
  type JournalIdentity,
} from './jito-recovery-journal-store';
import {
  VAULT_ITERATIONS,
  VAULT_MIN_PASSWORD_LENGTH,
} from './browser-wallet-vault';
import { UUID } from './wallet-operation';
import type { JitoAttempt } from './jito-sign-attempt-client';

/** Unintegrated same-origin foundation. No server reservation, owner
 * authentication, wallet signing, submission, network request or UI action is
 * provided here. A trusted caller MUST perform fresh authenticated owner-scoped
 * reads and check its UI context. IndexedDB strict durability is a browser
 * hint, not a guarantee against power loss, eviction or a cleared profile.
 * The encrypted key-check permits offline password guessing by anyone who
 * copies storage. PBKDF2 increases cost; the eight-character minimum does
 * not guarantee strength. Same-origin scripts/XSS and device compromise are
 * not prevented by this encryption. */
export type JitoJournalLock = object;
export type JitoJournalReservation = object;
type FreshRead = () => Promise<{
  ownerScope: string;
  record: JitoBundleRecord;
}>;
type LockState = {
  owner: string;
  guard: () => void;
  accepting: boolean;
  active: boolean;
  failed: boolean;
  tail: Promise<void>;
  reservations: Set<JitoJournalReservation>;
};
type Reservation = {
  lock: JitoJournalLock;
  identity: JournalIdentity;
  entry: JournalEntry;
  key: CryptoKey;
  importedEvidence?: Readonly<{ transaction: string; signature: string }>;
};
type FreshImportedEvidence = () => Promise<{
  ownerScope: string;
  record: JitoBundleRecord;
  attempt: JitoAttempt;
}>;
const locks = new WeakMap<JitoJournalLock, LockState>();
const reservations = new WeakMap<JitoJournalReservation, Reservation>();
const domain = 'PulseForge/JitoRecoveryJournal/v1';
const checkPlain = new TextEncoder().encode('jito-recovery-key-check-v1');
const failure = (): never => {
  throw Error('Recovery journal is unavailable or its context differs.');
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
function unhex(text: unknown, length: number): Uint8Array<ArrayBuffer> {
  if (
    typeof text !== 'string' ||
    text.length !== length * 2 ||
    !/^[a-f0-9]+$/.test(text)
  )
    return failure();
  return Uint8Array.from(text.match(/../g)!, (v) => parseInt(v, 16));
}
function guard(state: LockState, context = true, allowFailure = false) {
  if (!state.active || (state.failed && !allowFailure)) return failure();
  if (context) state.guard();
}
function queue<T>(
  token: JitoJournalLock,
  task: (s: LockState) => Promise<T>,
  requireContext = true,
  allowFailure = false,
) {
  const state = locks.get(token);
  if (!state || !state.active || !state.accepting)
    return Promise.reject(Error('Recovery journal lock is unavailable.'));
  const result = state.tail.then(async () => {
    guard(state, requireContext, allowFailure);
    return task(state);
  });
  state.tail = result.then(
    () => undefined,
    () => {
      state.failed = true;
    },
  );
  return result;
}

/** Cooperative same-origin owner lock. The supplied guard is trusted app code;
 * it must invalidate on sign-in, owner or UI-context changes. The callback
 * must hold this lock across the entire wallet/registration operation. */
export async function withJitoRecoveryJournalLock<T>(
  ownerScope: string,
  assertCurrent: () => void,
  callback: (token: JitoJournalLock) => Promise<T>,
): Promise<T> {
  if (
    typeof ownerScope !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ownerScope) ||
    typeof assertCurrent !== 'function' ||
    typeof callback !== 'function' ||
    typeof navigator === 'undefined' ||
    !navigator.locks
  )
    return failure();
  assertCurrent();
  return navigator.locks.request(
    `${domain}:${ownerScope}`,
    { mode: 'exclusive', ifAvailable: true },
    async (held) => {
      if (!held) return failure();
      assertCurrent();
      const token = Object.freeze({});
      const state: LockState = {
        owner: ownerScope,
        guard: assertCurrent,
        accepting: true,
        active: true,
        failed: false,
        tail: Promise.resolve(),
        reservations: new Set(),
      };
      locks.set(token, state);
      try {
        const result = await callback(token);
        state.accepting = false;
        await state.tail;
        guard(state);
        return result;
      } finally {
        state.accepting = false;
        await state.tail;
        state.active = false;
        for (const reservation of state.reservations)
          reservations.delete(reservation);
        state.reservations.clear();
        locks.delete(token);
      }
    },
  );
}

function entryKey(identity: JournalIdentity) {
  return `${identity.ownerScope}:${identity.bundleId}:${identity.packet}`;
}
function same(a: JournalIdentity, b: JournalIdentity) {
  return (
    a.ownerScope === b.ownerScope &&
    a.projectId === b.projectId &&
    a.sessionId === b.sessionId &&
    a.bundleId === b.bundleId &&
    a.digest === b.digest &&
    a.packet === b.packet &&
    a.wallet === b.wallet
  );
}
async function context(
  owner: string,
  input: JitoBundleManifest,
  packet: number,
  current: boolean,
) {
  const manifest = structuredClone(input);
  await requireJitoManifest(manifest, current);
  if (!Number.isInteger(packet) || packet < 0 || packet > manifest.swaps.length)
    return failure();
  const identity: JournalIdentity = Object.freeze({
    ownerScope: owner,
    projectId: manifest.projectId,
    sessionId: manifest.sessionId,
    bundleId: manifest.id,
    digest: manifest.sha256,
    packet,
    wallet: manifest.swaps[packet]?.wallet ?? manifest.tip.wallet,
  });
  return { identity, manifest };
}
async function requireFresh(
  state: LockState,
  identity: JournalIdentity,
  readFresh: FreshRead,
) {
  if (typeof readFresh !== 'function') return failure();
  const fresh = structuredClone(await readFresh());
  guard(state);
  if (
    !fresh ||
    fresh.ownerScope !== state.owner ||
    !fresh.record ||
    ![
      'reviewed',
      'submitting',
      'submitted',
      'finalized',
      'cancelled',
      'expired',
    ].includes(fresh.record.state) ||
    !Array.isArray(fresh.record.signatures)
  )
    return failure();
  const { identity: actual, manifest } = await context(
    state.owner,
    fresh.record.manifest,
    identity.packet,
    false,
  );
  guard(state);
  if (
    !same(identity, actual) ||
    fresh.record.signatures.length !== manifest.swaps.length + 1 ||
    fresh.record.signatures.some(
      (s) =>
        s !== null &&
        (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)),
    )
  )
    return failure();
  return { manifest, record: fresh.record };
}
function entry(value: unknown, identity: JournalIdentity): JournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return failure();
  const data = value as JournalEntry;
  if (
    Object.keys(data).sort().join(',') !==
      [
        'ciphertext',
        'check',
        'checkIv',
        'identity',
        'iv',
        'key',
        'nonce',
        'salt',
        'state',
        'version',
      ]
        .sort()
        .join(',') ||
    data.version !== 1 ||
    data.key !== entryKey(identity) ||
    !data.identity ||
    Object.keys(data.identity).sort().join(',') !==
      [
        'bundleId',
        'digest',
        'ownerScope',
        'packet',
        'projectId',
        'sessionId',
        'wallet',
      ]
        .sort()
        .join(',') ||
    !same(data.identity, identity) ||
    typeof data.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(data.nonce) ||
    typeof data.salt !== 'string' ||
    !/^[a-f0-9]{32}$/.test(data.salt) ||
    typeof data.checkIv !== 'string' ||
    !/^[a-f0-9]{24}$/.test(data.checkIv) ||
    typeof data.check !== 'string' ||
    data.check.length !== (checkPlain.length + 16) * 2 ||
    !/^[a-f0-9]+$/.test(data.check) ||
    !['unknown', 'retained'].includes(data.state) ||
    (data.state === 'unknown' &&
      (data.iv !== null || data.ciphertext !== null)) ||
    (data.state === 'retained' &&
      (typeof data.iv !== 'string' ||
        !/^[a-f0-9]{24}$/.test(data.iv) ||
        typeof data.ciphertext !== 'string' ||
        !/^[a-f0-9]{160}$/.test(data.ciphertext)))
  )
    return failure();
  return data;
}

/** Discover local markers only after trusted app code freshly verifies the
 * authenticated owner. Results are not proof of chain or server state, and a
 * missing marker never authorizes signing or cancellation. A 'retained' label
 * is unverified until authenticated inspection decrypts and checks it. Never
 * delete UNKNOWN because it is old or absent from a server history page. */
export function listJitoRecoveryJournalPending(
  token: JitoJournalLock,
  projectId: string,
  sessionId: string,
  readFreshOwner: () => Promise<string>,
): Promise<
  Array<{ bundleId: string; packet: number; status: 'unknown' | 'retained' }>
> {
  return queue(token, async (state) => {
    if (
      !UUID.test(projectId) ||
      !UUID.test(sessionId) ||
      typeof readFreshOwner !== 'function'
    )
      return failure();
    const firstOwner = await readFreshOwner();
    guard(state);
    if (firstOwner !== state.owner) return failure();
    const records = await listJournalEntries();
    guard(state);
    const result: Array<{
      bundleId: string;
      packet: number;
      status: 'unknown' | 'retained';
    }> = [];
    const seen = new Set<string>();
    for (const raw of records) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return failure();
      const identity = (raw as { identity?: JournalIdentity }).identity;
      if (
        !identity ||
        typeof identity !== 'object' ||
        Array.isArray(identity) ||
        typeof identity.ownerScope !== 'string' ||
        !/^[a-f0-9]{64}$/.test(identity.ownerScope)
      )
        return failure();
      if (identity.ownerScope !== state.owner) continue;
      if (
        typeof identity.projectId !== 'string' ||
        !UUID.test(identity.projectId) ||
        typeof identity.sessionId !== 'string' ||
        !UUID.test(identity.sessionId) ||
        typeof identity.bundleId !== 'string' ||
        !UUID.test(identity.bundleId) ||
        typeof identity.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(identity.digest) ||
        !Number.isInteger(identity.packet) ||
        identity.packet < 0 ||
        identity.packet > 4 ||
        typeof identity.wallet !== 'string' ||
        identity.wallet.length > 44
      )
        return failure();
      let wallet: Uint8Array;
      try {
        wallet = bs58.decode(identity.wallet);
      } catch {
        return failure();
      }
      if (wallet.length !== 32 || bs58.encode(wallet) !== identity.wallet)
        return failure();
      const stored = entry(raw, identity);
      if (
        identity.projectId === projectId &&
        identity.sessionId === sessionId
      ) {
        const unique = `${identity.bundleId}:${identity.packet}`;
        if (seen.has(unique)) return failure();
        seen.add(unique);
        result.push({
          bundleId: identity.bundleId,
          packet: identity.packet,
          status: stored.state,
        });
      }
    }
    const secondOwner = await readFreshOwner();
    guard(state);
    if (secondOwner !== state.owner) return failure();
    return result;
  });
}
function associated(
  identity: JournalIdentity,
  nonce: string,
  purpose: 'signature' | 'key-check',
) {
  return new TextEncoder().encode(
    JSON.stringify([
      domain,
      identity.ownerScope,
      identity.projectId,
      identity.sessionId,
      identity.bundleId,
      identity.digest,
      identity.packet,
      identity.wallet,
      nonce,
      purpose,
    ]),
  );
}
async function derive(password: string, salt: string) {
  if (typeof password !== 'string' || password.length > 1024) return failure();
  const encoded = new TextEncoder().encode(password);
  let kdfSalt: Uint8Array<ArrayBuffer> | undefined;
  try {
    const prefix = new TextEncoder().encode(`${domain}/PBKDF2-SHA256`);
    const random = unhex(salt, 16);
    kdfSalt = new Uint8Array(prefix.length + 1 + random.length);
    kdfSalt.set(prefix);
    kdfSalt.set(random, prefix.length + 1);
    if (
      Array.from(password).length < VAULT_MIN_PASSWORD_LENGTH ||
      encoded.length > 1024
    )
      return failure();
    const material = await crypto.subtle.importKey(
      'raw',
      encoded,
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: kdfSalt,
        iterations: VAULT_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    encoded.fill(0);
    kdfSalt?.fill(0);
  }
}

async function checkKey(
  identity: JournalIdentity,
  stored: JournalEntry,
  key: CryptoKey,
) {
  let checked: ArrayBuffer;
  try {
    checked = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unhex(stored.checkIv, 12),
        additionalData: associated(identity, stored.nonce, 'key-check'),
        tagLength: 128,
      },
      key,
      unhex(stored.check, checkPlain.length + 16),
    );
  } catch {
    return failure();
  }
  const bytes = new Uint8Array(checked);
  try {
    if (
      bytes.length !== checkPlain.length ||
      bytes.some((v, i) => v !== checkPlain[i])
    )
      return failure();
  } finally {
    bytes.fill(0);
  }
}

/** The caller must independently validate the normal vault password or confirm
 * a new recovery password before this call. This inserts UNKNOWN before any
 * subsequent wallet prompt and never removes it automatically. */
export function reserveJitoRecoveryUnknown(
  token: JitoJournalLock,
  input: JitoBundleManifest,
  packet: number,
  password: string,
  readFresh: FreshRead,
): Promise<JitoJournalReservation> {
  return queue(token, async (state) => {
    const { identity } = await context(state.owner, input, packet, true);
    guard(state);
    const before = await requireFresh(state, identity, readFresh);
    if (
      before.record.state !== 'reviewed' ||
      before.record.signatures[packet] !== null
    )
      return failure();
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const key = await derive(password, salt);
    guard(state);
    const checkIv = crypto.getRandomValues(new Uint8Array(12));
    const check = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: checkIv,
        additionalData: associated(identity, nonce, 'key-check'),
        tagLength: 128,
      },
      key,
      checkPlain,
    );
    guard(state);
    const again = await requireFresh(state, identity, readFresh);
    if (
      again.record.state !== 'reviewed' ||
      again.record.signatures[packet] !== null
    )
      return failure();
    const stored: JournalEntry = {
      version: 1,
      key: entryKey(identity),
      identity,
      nonce,
      salt,
      checkIv: hex(checkIv),
      check: hex(new Uint8Array(check)),
      state: 'unknown',
      iv: null,
      ciphertext: null,
    };
    await insertJournalUnknown(stored);
    guard(state);
    const tokenReservation = Object.freeze({});
    reservations.set(tokenReservation, {
      lock: token,
      identity,
      entry: stored,
      key,
    });
    state.reservations.add(tokenReservation);
    return tokenReservation;
  });
}

/** Reserve local storage for an already signed imported packet, without
 * granting signer or submission authority. `readFreshEvidence` is trusted app
 * code and must authenticate the exact response scope and validate the whole
 * owned v2 snapshot before selecting its attempt. A failed or ambiguous insert
 * always leaves any UNKNOWN marker for explicit recovery. */
export function reserveJitoImportedEvidence(
  token: JitoJournalLock,
  input: JitoBundleManifest,
  packet: number,
  password: string,
  transaction: string,
  expectedAttemptId: string,
  readFreshEvidence: FreshImportedEvidence,
): Promise<JitoJournalReservation> {
  return queue(token, async (state) => {
    if (
      !UUID.test(expectedAttemptId) ||
      typeof readFreshEvidence !== 'function'
    )
      return failure();
    const { identity, manifest } = await context(
      state.owner,
      input,
      packet,
      false,
    );
    guard(state);
    const checked = await createJitoPacketRecovery(
      manifest,
      packet,
      transaction,
    );
    guard(state);
    const requireUnknown = async () => {
      // Own one response snapshot before any asynchronous validation; callers
      // cannot mutate an in-flight attempt or record after this point.
      const fresh = structuredClone(await readFreshEvidence());
      guard(state);
      const current = await requireFresh(state, identity, async () => fresh);
      const attempt = fresh?.attempt;
      if (
        current.record.state !== 'reviewed' ||
        current.record.signatures[packet] !== null ||
        !attempt ||
        attempt.attemptId !== expectedAttemptId ||
        attempt.bundleId !== identity.bundleId ||
        attempt.manifestSha256 !== identity.digest ||
        attempt.packet !== packet ||
        attempt.signer !== identity.wallet ||
        attempt.intentId !== (manifest.swaps[packet]?.id ?? null) ||
        attempt.state !== 'unknown' ||
        attempt.signature !== null ||
        attempt.transaction !== null
      )
        return failure();
    };
    await requireUnknown();
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const key = await derive(password, salt);
    guard(state);
    const checkIv = crypto.getRandomValues(new Uint8Array(12));
    const check = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: checkIv,
        additionalData: associated(identity, nonce, 'key-check'),
        tagLength: 128,
      },
      key,
      checkPlain,
    );
    guard(state);
    await requireUnknown();
    const stored: JournalEntry = {
      version: 1,
      key: entryKey(identity),
      identity,
      nonce,
      salt,
      checkIv: hex(checkIv),
      check: hex(new Uint8Array(check)),
      state: 'unknown',
      iv: null,
      ciphertext: null,
    };
    await insertJournalUnknown(stored);
    guard(state);
    const inserted = entry(await readJournalEntry(stored.key), identity);
    guard(state);
    if (JSON.stringify(inserted) !== JSON.stringify(stored)) return failure();
    // A changed server attempt or owner cannot turn the committed marker into
    // authority. Leave it UNKNOWN if this final recheck is ambiguous.
    await requireUnknown();
    const reservation = Object.freeze({});
    reservations.set(reservation, {
      lock: token,
      identity,
      entry: stored,
      key,
      importedEvidence: Object.freeze({
        transaction,
        signature: checked.signature,
      }),
    });
    state.reservations.add(reservation);
    return reservation;
  });
}

/** Reopen an UNKNOWN marker only for a separately supplied exact signed packet.
 * This never releases it or establishes that a wallet did not sign. */
export function resumeJitoRecoveryUnknown(
  token: JitoJournalLock,
  input: JitoBundleManifest,
  packet: number,
  password: string,
  readFresh: FreshRead,
): Promise<JitoJournalReservation> {
  return queue(token, async (state) => {
    const { identity } = await context(state.owner, input, packet, false);
    guard(state);
    const first = await requireFresh(state, identity, readFresh);
    const stored = entry(await readJournalEntry(entryKey(identity)), identity);
    guard(state);
    if (stored.state !== 'unknown') return failure();
    const key = await derive(password, stored.salt);
    guard(state);
    await checkKey(identity, stored, key);
    guard(state);
    const second = await requireFresh(state, identity, readFresh);
    const current = entry(await readJournalEntry(stored.key), identity);
    guard(state);
    if (
      JSON.stringify(current) !== JSON.stringify(stored) ||
      second.record.state !== first.record.state ||
      second.record.signatures[packet] !== first.record.signatures[packet]
    )
      return failure();
    const tokenReservation = Object.freeze({});
    reservations.set(tokenReservation, {
      lock: token,
      identity,
      entry: stored,
      key,
    });
    state.reservations.add(tokenReservation);
    return tokenReservation;
  });
}

/** Verify and encrypt an exact returned signed packet. The WebCrypto operation
 * occurs before the IDB transaction; the transaction replaces only the exact
 * nonce-bound UNKNOWN marker and is awaited through commit. */
export function retainJitoRecoverySignature(
  token: JitoJournalLock,
  reservation: JitoJournalReservation,
  input: JitoBundleManifest,
  transaction: string,
): Promise<void> {
  return queue(
    token,
    async (state) => {
      const reserved = reservations.get(reservation);
      if (
        !reserved ||
        reserved.lock !== token ||
        reserved.identity.ownerScope !== state.owner
      )
        return failure();
      const { identity, manifest } = await context(
        state.owner,
        input,
        reserved.identity.packet,
        false,
      );
      guard(state, false, true);
      if (!same(identity, reserved.identity)) return failure();
      const checked = await createJitoPacketRecovery(
        manifest,
        identity.packet,
        transaction,
      );
      if (
        reserved.importedEvidence &&
        (reserved.importedEvidence.transaction !== transaction ||
          reserved.importedEvidence.signature !== checked.signature)
      )
        return failure();
      guard(state, false, true);
      const signature = Uint8Array.from(bs58.decode(checked.signature));
      if (
        signature.length !== 64 ||
        bs58.encode(signature) !== checked.signature
      )
        return failure();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      if (hex(iv) === reserved.entry.checkIv) {
        signature.fill(0);
        return failure();
      }
      let encrypted: ArrayBuffer;
      try {
        encrypted = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: associated(
              identity,
              reserved.entry.nonce,
              'signature',
            ),
            tagLength: 128,
          },
          reserved.key,
          signature,
        );
      } finally {
        signature.fill(0);
      }
      guard(state, false, true);
      const next: JournalEntry = {
        ...reserved.entry,
        state: 'retained',
        iv: hex(iv),
        ciphertext: hex(new Uint8Array(encrypted)),
      };
      await retainJournalEntry(reserved.entry, next);
      guard(state, false, true);
      const stored = entry(await readJournalEntry(next.key), identity);
      guard(state, false, true);
      if (JSON.stringify(stored) !== JSON.stringify(next)) return failure();
      reservations.delete(reservation);
      state.reservations.delete(reservation);
    },
    false,
    true,
  );
}

/** Inspect only after fresh authenticated owner-scoped reads supplied by
 * trusted app code. UNKNOWN and NOT-FOUND never prove that no wallet was
 * invoked, and never authorize signing, cancellation or submission. */
export function inspectJitoRecoveryJournal(
  token: JitoJournalLock,
  input: JitoBundleManifest,
  packet: number,
  password: string,
  readFresh: FreshRead,
): Promise<
  | { status: 'not-found' | 'unknown' }
  | { status: 'retained'; signature: string; transaction: string }
> {
  return queue(token, async (state) => {
    const verified = await inspectLocked(
      state,
      input,
      packet,
      password,
      readFresh,
    );
    return verified.result;
  });
}

async function inspectLocked(
  state: LockState,
  input: JitoBundleManifest,
  packet: number,
  password: string,
  readFresh: FreshRead,
): Promise<{
  result:
    | { status: 'not-found' | 'unknown' }
    | { status: 'retained'; signature: string; transaction: string };
  identity: JournalIdentity;
  stored?: JournalEntry;
}> {
  const { identity } = await context(state.owner, input, packet, false);
  guard(state);
  const first = await requireFresh(state, identity, readFresh);
  const raw = await readJournalEntry(entryKey(identity));
  guard(state);
  if (raw === undefined)
    return { result: { status: 'not-found' as const }, identity };
  const stored = entry(raw, identity);
  if (stored.state === 'unknown')
    return { result: { status: 'unknown' as const }, identity, stored };
  const key = await derive(password, stored.salt);
  guard(state);
  await checkKey(identity, stored, key);
  guard(state);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unhex(stored.iv, 12),
        additionalData: associated(identity, stored.nonce, 'signature'),
        tagLength: 128,
      },
      key,
      unhex(stored.ciphertext, 80),
    );
  } catch {
    return failure();
  }
  const bytes = new Uint8Array(plain);
  try {
    if (bytes.length !== 64) return failure();
    const signature = bs58.encode(bytes);
    const original =
      first.manifest.swaps[packet]?.transaction ??
      first.manifest.tip.transaction;
    if (typeof original !== 'string' || original.length > 1644)
      return failure();
    const tx = Uint8Array.from(atob(original), (v) => v.charCodeAt(0));
    if (tx.length < 65 || tx[0] !== 1 || tx.slice(1, 65).some(Boolean))
      return failure();
    tx.set(bytes, 1);
    const transaction = btoa(String.fromCharCode(...tx));
    const checked = await createJitoPacketRecovery(
      first.manifest,
      packet,
      transaction,
    );
    guard(state);
    if (checked.signature !== signature) return failure();
    const second = await requireFresh(state, identity, readFresh);
    const current = entry(await readJournalEntry(stored.key), identity);
    guard(state);
    if (
      JSON.stringify(current) !== JSON.stringify(stored) ||
      second.record.state !== first.record.state ||
      second.record.signatures[packet] !== first.record.signatures[packet] ||
      (second.record.signatures[packet] !== null &&
        second.record.signatures[packet] !== signature)
    )
      return failure();
    return {
      result: { status: 'retained' as const, signature, transaction },
      identity,
      stored,
    };
  } finally {
    bytes.fill(0);
  }
}

/** Remove a retained local envelope only after exact signature verification and
 * a fresh authenticated server read confirms the same registered signature.
 * UNKNOWN, absent and mismatched records never qualify. An ambiguous storage
 * error must be reconciled again; disappearance alone proves nothing. */
export function acknowledgeJitoRecoveryRegistered(
  token: JitoJournalLock,
  input: JitoBundleManifest,
  packet: number,
  password: string,
  readFresh: FreshRead,
): Promise<void> {
  return queue(token, async (state) => {
    const checked = await inspectLocked(
      state,
      input,
      packet,
      password,
      readFresh,
    );
    if (checked.result.status !== 'retained' || !checked.stored)
      return failure();
    const current = await requireFresh(state, checked.identity, readFresh);
    if (current.record.signatures[packet] !== checked.result.signature)
      return failure();
    guard(state);
    await deleteRetainedJournalEntry(checked.stored);
    guard(state);
  });
}
