import type { ConditionalOrder } from './conditional-order';
import { UUID } from './wallet-operation';
export type ConditionalLevelStatus = {
  orderId: string;
  level: number;
  intentId: string;
  unitsRaw: string;
  state: 'awaiting_signature' | 'signed' | 'submitted' | 'filled';
  signature: string | null;
  receiptId: string | null;
};
export function conditionalLevelStatuses(
  value: unknown,
  orders: ConditionalOrder[],
): ConditionalLevelStatus[] {
  if (!Array.isArray(value) || value.length > 5000)
    throw new Error('Conditional level status unavailable.');
  const seen = new Set<string>();
  for (const s of value as ConditionalLevelStatus[]) {
    const level = orders
        .find((o) => o.id === s?.orderId)
        ?.terms.levels.find((l) => l.level === s.level),
      key = `${s?.orderId}:${s?.level}`;
    if (
      !s ||
      !level ||
      seen.has(key) ||
      s.unitsRaw !== level.unitsRaw ||
      !UUID.test(s.intentId) ||
      !['awaiting_signature', 'signed', 'submitted', 'filled'].includes(
        s.state,
      ) ||
      (s.state === 'awaiting_signature'
        ? s.signature !== null
        : typeof s.signature !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s.signature)) ||
      (s.state === 'filled'
        ? !s.receiptId || !UUID.test(s.receiptId)
        : s.receiptId !== null)
    )
      throw new Error('Conditional level status differs.');
    seen.add(key);
  }
  return value;
}
