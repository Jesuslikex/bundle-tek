import type { JitoBundleRecord } from './jito-bundle';

/** A transient provider report, not a receipt, atomicity proof or authority. */
export type JitoChainObservation = {
  format: 'jito-chain-observation-v1';
  bundleId: string;
  bundleSha256: string;
  state: 'reviewed' | 'submitting' | 'submitted';
  observedAt: string;
  packets: Array<{
    packet: number;
    signature: string | null;
    status:
      | 'not-registered'
      | 'not-found'
      | 'unavailable'
      | 'processed-success'
      | 'processed-failure'
      | 'confirmed-success'
      | 'confirmed-failure'
      | 'finalized-success'
      | 'finalized-failure';
    slot: number | null;
  }>;
};

const statuses = new Set<JitoChainObservation['packets'][number]['status']>([
  'not-registered',
  'not-found',
  'unavailable',
  'processed-success',
  'processed-failure',
  'confirmed-success',
  'confirmed-failure',
  'finalized-success',
  'finalized-failure',
]);
const activeStates = new Set(['reviewed', 'submitting', 'submitted']);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Classify only the existing positional status response. Raw errors never leave this function. */
export function createJitoChainObservation(
  record: JitoBundleRecord,
  raw: unknown,
  observedAt: string,
): JitoChainObservation | null {
  if (
    !activeStates.has(record.state) ||
    !object(raw) ||
    !Array.isArray(raw.value)
  )
    return null;
  const values = raw.value;
  const signed = record.signatures.filter((signature) => signature !== null);
  if (!signed.length || signed.length !== values.length) return null;
  let cursor = 0;
  const packets: JitoChainObservation['packets'] = record.signatures.map(
    (signature, packet) => {
      if (signature === null)
        return { packet, signature, status: 'not-registered', slot: null };
      const value: unknown = values[cursor++];
      if (value === null)
        return { packet, signature, status: 'not-found', slot: null };
      if (!object(value))
        return { packet, signature, status: 'unavailable', slot: null };
      const commitment = value.confirmationStatus;
      const rawSlot = value.slot;
      const slot =
        typeof rawSlot === 'number'
          ? rawSlot
          : typeof rawSlot === 'string' && /^(0|[1-9]\d{0,15})$/.test(rawSlot)
            ? Number(rawSlot)
            : NaN;
      if (
        typeof commitment !== 'string' ||
        !['processed', 'confirmed', 'finalized'].includes(commitment) ||
        !Number.isSafeInteger(slot) ||
        slot < 1 ||
        !Object.hasOwn(value, 'err') ||
        !(
          value.err === null ||
          typeof value.err === 'string' ||
          object(value.err)
        )
      )
        return { packet, signature, status: 'unavailable', slot: null };
      return {
        packet,
        signature,
        status:
          `${commitment}-${value.err === null ? 'success' : 'failure'}` as JitoChainObservation['packets'][number]['status'],
        slot,
      };
    },
  );
  const observation: JitoChainObservation = {
    format: 'jito-chain-observation-v1',
    bundleId: record.manifest.id,
    bundleSha256: record.manifest.sha256,
    state: record.state as JitoChainObservation['state'],
    observedAt,
    packets,
  };
  return requireJitoChainObservation(observation, record);
}

/** Rebind a provider report to the exact owner-scoped record before display. */
export function requireJitoChainObservation(
  value: unknown,
  record: JitoBundleRecord,
): JitoChainObservation {
  if (
    !object(value) ||
    !exactKeys(value, [
      'format',
      'bundleId',
      'bundleSha256',
      'state',
      'observedAt',
      'packets',
    ]) ||
    value.format !== 'jito-chain-observation-v1' ||
    value.bundleId !== record.manifest.id ||
    value.bundleSha256 !== record.manifest.sha256 ||
    value.state !== record.state ||
    !activeStates.has(record.state) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Array.isArray(value.packets) ||
    value.packets.length !== record.signatures.length ||
    value.packets.length < 2 ||
    value.packets.length > 5
  )
    throw Error('Bundle chain observation differs.');
  for (const [index, item] of value.packets.entries()) {
    if (
      !object(item) ||
      !exactKeys(item, ['packet', 'signature', 'status', 'slot']) ||
      item.packet !== index ||
      item.signature !== record.signatures[index] ||
      typeof item.status !== 'string' ||
      !statuses.has(
        item.status as JitoChainObservation['packets'][number]['status'],
      )
    )
      throw Error('Bundle chain observation differs.');
    const absent = item.status === 'not-registered';
    const noSlot =
      absent || item.status === 'not-found' || item.status === 'unavailable';
    if (
      absent !== (item.signature === null) ||
      (noSlot
        ? item.slot !== null
        : typeof item.slot !== 'number' ||
          !Number.isSafeInteger(item.slot) ||
          item.slot < 1)
    )
      throw Error('Bundle chain observation differs.');
  }
  return value as JitoChainObservation;
}
