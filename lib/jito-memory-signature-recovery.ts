import bs58 from 'bs58';
import { requireJitoManifest, type JitoBundleManifest } from './jito-bundle';
import { createJitoPacketRecovery } from './jito-packet-recovery';
import { WalletSigningRejected } from './wallet-signing-rejection';
import { UUID } from './wallet-operation';

type Identity = Readonly<{
  ownerScope: string;
  projectId: string;
  sessionId: string;
  bundleId: string;
  digest: string;
  packet: number;
  wallet: string;
}>;
type Slot = {
  identity: Identity;
  token: object;
  state: 'reserved' | 'started' | 'retained';
  signature: string | null;
  capturing: boolean;
};
export type JitoMemoryReservation = object;
export type JitoOperationToken = object;
export type JitoMemoryInspection =
  | { status: 'absent' }
  | { status: 'reserved' | 'started' }
  | { status: 'retained'; signature: string; transaction: string };

/** Ephemeral signature recovery only. The caller must verify the owner scope
 * against a fresh authenticated server response before inspecting or clearing.
 * No storage, fetch, signing, registration or submission is performed here. */
export function createJitoMemorySignatureRecovery(capacity = 100) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100)
    throw Error('Jito recovery capacity differs.');
  const slots = new Map<string, Slot>();
  const tokens = new WeakMap<object, string>();
  const listeners = new Set<() => void>();
  const operationListeners = new Set<() => void>();
  let operation: {
    token: JitoOperationToken;
    owner: string;
    bundleId: string | null;
    packet: number | null;
    kind: 'sign' | 'mutation';
  } | null = null;
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // An observer must not change the retained result or another listener.
      }
    }
  }
  function subscribe(listener: () => void) {
    if (typeof listener !== 'function' || listeners.size >= 100)
      throw Error('Jito recovery observer capacity reached.');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function subscribeOperations(listener: () => void) {
    if (typeof listener !== 'function' || operationListeners.size >= 100)
      throw Error('Jito operation observer capacity reached.');
    operationListeners.add(listener);
    return () => {
      operationListeners.delete(listener);
    };
  }
  function notifyOperation() {
    for (const listener of operationListeners) {
      try {
        listener();
      } catch {
        /* Keep the operation independent of its observers. */
      }
    }
  }
  function operationActive() {
    return operation !== null;
  }
  function startOperation(
    owner: string,
    bundleId?: string,
    packet?: number,
  ): JitoOperationToken {
    if (
      !/^[a-f0-9]{64}$/.test(owner) ||
      (bundleId !== undefined &&
        (!UUID.test(bundleId) ||
          !Number.isInteger(packet) ||
          packet! < 0 ||
          packet! > 4))
    )
      throw Error('Jito operation context differs.');
    if (operation) throw Error('Another Jito action is in progress.');
    const token = Object.freeze({});
    operation = {
      token,
      owner,
      bundleId: bundleId ?? null,
      packet: packet ?? null,
      kind: bundleId === undefined ? 'mutation' : 'sign',
    };
    notifyOperation();
    return token;
  }
  function requireRegistration(
    token: JitoOperationToken,
    owner: string,
    bundleId: string,
    packet: number,
  ) {
    if (
      !operation ||
      operation.token !== token ||
      operation.kind !== 'sign' ||
      operation.owner !== owner ||
      operation.bundleId !== bundleId ||
      operation.packet !== packet
    )
      throw Error('Jito signing operation context differs.');
  }
  function finishOperation(token: JitoOperationToken) {
    if (!operation || operation.token !== token)
      throw Error('Jito operation context differs.');
    operation = null;
    notifyOperation();
  }
  const slotKey = (identity: Identity) =>
    `${identity.ownerScope}:${identity.bundleId}:${identity.packet}`;
  function has(ownerScope: string, bundleId: string, packet: number) {
    if (
      typeof ownerScope !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ownerScope) ||
      typeof bundleId !== 'string' ||
      !UUID.test(bundleId) ||
      !Number.isInteger(packet) ||
      packet < 0 ||
      packet > 4
    )
      throw Error('Jito recovery lookup differs.');
    return slots.has(`${ownerScope}:${bundleId}:${packet}`);
  }
  function pending(ownerScope: string, projectId: string, sessionId: string) {
    if (
      !/^[a-f0-9]{64}$/.test(ownerScope) ||
      !UUID.test(projectId) ||
      !UUID.test(sessionId)
    )
      throw Error('Jito recovery lookup differs.');
    return [...slots.values()]
      .filter(
        (slot) =>
          slot.identity.ownerScope === ownerScope &&
          slot.identity.projectId === projectId &&
          slot.identity.sessionId === sessionId,
      )
      .map((slot) => ({
        bundleId: slot.identity.bundleId,
        packet: slot.identity.packet,
      }));
  }
  const same = (a: Identity, b: Identity) =>
    a.ownerScope === b.ownerScope &&
    a.projectId === b.projectId &&
    a.sessionId === b.sessionId &&
    a.bundleId === b.bundleId &&
    a.digest === b.digest &&
    a.packet === b.packet &&
    a.wallet === b.wallet;
  async function context(
    ownerScope: string,
    input: JitoBundleManifest,
    packet: number,
    current: boolean,
  ) {
    if (typeof ownerScope !== 'string' || !/^[a-f0-9]{64}$/.test(ownerScope))
      throw Error('Jito recovery owner scope differs.');
    const manifest = structuredClone(input);
    await requireJitoManifest(manifest, current);
    if (
      !Number.isInteger(packet) ||
      packet < 0 ||
      packet > manifest.swaps.length
    )
      throw Error('Jito recovery packet differs.');
    const wallet = manifest.swaps[packet]?.wallet ?? manifest.tip.wallet;
    const identity = Object.freeze({
      ownerScope,
      projectId: manifest.projectId,
      sessionId: manifest.sessionId,
      bundleId: manifest.id,
      digest: manifest.sha256,
      packet,
      wallet,
    });
    return { identity, manifest };
  }
  function forToken(token: JitoMemoryReservation) {
    if (!token || typeof token !== 'object')
      throw Error('Jito recovery reservation differs.');
    const key = tokens.get(token),
      slot = key === undefined ? undefined : slots.get(key);
    if (!slot || slot.token !== token)
      throw Error('Jito recovery reservation differs.');
    return { key: key!, slot };
  }
  function drop(key: string, slot: Slot) {
    slots.delete(key);
    tokens.delete(slot.token);
    notify();
  }
  async function reserve(
    ownerScope: string,
    manifest: JitoBundleManifest,
    packet: number,
  ): Promise<JitoMemoryReservation> {
    const { identity } = await context(ownerScope, manifest, packet, true);
    const key = slotKey(identity);
    if (slots.has(key))
      throw Error('Original Jito packet recovery is pending.');
    if (slots.size >= capacity) throw Error('Jito recovery capacity reached.');
    const token = Object.freeze({});
    slots.set(key, {
      identity,
      token,
      state: 'reserved',
      signature: null,
      capturing: false,
    });
    tokens.set(token, key);
    notify();
    return token;
  }
  function markStarted(token: JitoMemoryReservation) {
    const { slot } = forToken(token);
    if (slot.state !== 'reserved')
      throw Error('Jito recovery already started.');
    slot.state = 'started';
    notify();
  }
  function releaseUnstarted(token: JitoMemoryReservation) {
    const { key, slot } = forToken(token);
    if (slot.state !== 'reserved')
      throw Error('Jito recovery already started.');
    drop(key, slot);
  }
  function releaseRejected(token: JitoMemoryReservation, error: unknown) {
    const { key, slot } = forToken(token);
    if (
      slot.state !== 'started' ||
      slot.capturing ||
      !(error instanceof WalletSigningRejected)
    )
      throw Error('Jito recovery rejection is not explicit.');
    drop(key, slot);
  }
  async function capture(
    token: JitoMemoryReservation,
    input: JitoBundleManifest,
    transaction: string,
  ) {
    const { key, slot } = forToken(token);
    if (slot.state === 'reserved')
      throw Error('Jito recovery has not started.');
    if (slot.capturing)
      throw Error('Jito recovery capture is already pending.');
    slot.capturing = true;
    try {
      const { identity, manifest } = await context(
        slot.identity.ownerScope,
        input,
        slot.identity.packet,
        false,
      );
      if (!same(slot.identity, identity) || slots.get(key) !== slot)
        throw Error('Jito recovery packet context differs.');
      const checked = await createJitoPacketRecovery(
        manifest,
        identity.packet,
        transaction,
      );
      if (slots.get(key) !== slot)
        throw Error('Jito recovery reservation differs.');
      if (slot.signature !== null && slot.signature !== checked.signature)
        throw Error('Jito recovery signature differs.');
      slot.signature = checked.signature;
      slot.state = 'retained';
      notify();
      return checked.signature;
    } finally {
      slot.capturing = false;
    }
  }
  async function inspect(
    ownerScope: string,
    input: JitoBundleManifest,
    packet: number,
  ): Promise<JitoMemoryInspection> {
    const { identity, manifest } = await context(
      ownerScope,
      input,
      packet,
      false,
    );
    const slot = slots.get(slotKey(identity));
    if (!slot) return { status: 'absent' };
    if (!same(slot.identity, identity))
      throw Error('Jito recovery context differs.');
    if (slot.state !== 'retained') return { status: slot.state };
    if (slot.signature === null)
      throw Error('Jito recovery signature unavailable.');
    const signature = slot.signature,
      decoded = bs58.decode(signature);
    if (decoded.length !== 64 || bs58.encode(decoded) !== signature)
      throw Error('Jito recovery signature differs.');
    const original =
      manifest.swaps[packet]?.transaction ?? manifest.tip.transaction;
    if (typeof original !== 'string' || original.length > 1644)
      throw Error('Jito recovery unsigned packet exceeds bounds.');
    const bytes = Uint8Array.from(atob(original), (value) =>
      value.charCodeAt(0),
    );
    if (bytes.length < 65 || bytes[0] !== 1 || bytes.slice(1, 65).some(Boolean))
      throw Error('Jito recovery unsigned packet differs.');
    bytes.set(decoded, 1);
    const transaction = btoa(String.fromCharCode(...bytes));
    const verified = await createJitoPacketRecovery(
      manifest,
      packet,
      transaction,
    );
    if (
      verified.signature !== signature ||
      slots.get(slotKey(identity)) !== slot
    )
      throw Error('Jito recovery signature differs.');
    return { status: 'retained', signature, transaction };
  }
  async function acknowledge(
    ownerScope: string,
    input: JitoBundleManifest,
    packet: number,
    signature: string,
    assertCurrent: () => void,
  ) {
    if (typeof assertCurrent !== 'function')
      throw Error('Jito recovery context guard required.');
    const { identity } = await context(ownerScope, input, packet, false);
    assertCurrent();
    const key = slotKey(identity),
      slot = slots.get(key);
    if (
      !slot ||
      !same(slot.identity, identity) ||
      slot.state !== 'retained' ||
      slot.capturing ||
      typeof signature !== 'string' ||
      slot.signature !== signature
    )
      throw Error('Jito recovery acknowledgement differs.');
    assertCurrent();
    drop(key, slot);
  }
  return Object.freeze({
    subscribe,
    subscribeOperations,
    has,
    pending,
    operationActive,
    startOperation,
    requireRegistration,
    finishOperation,
    reserve,
    markStarted,
    releaseUnstarted,
    releaseRejected,
    capture,
    inspect,
    acknowledge,
  });
}
export type JitoMemorySignatureRecovery = ReturnType<
  typeof createJitoMemorySignatureRecovery
>;
