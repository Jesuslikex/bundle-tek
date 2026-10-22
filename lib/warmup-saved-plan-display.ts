import { z } from 'zod';
import type { SavedWarmup } from './wallet-warmup-storage';

const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const address = z.string().min(1).max(64);
const amount = z.string().regex(/^\d{1,12}(?:\.\d{1,18})?$/);
const date = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)));
const saved = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  revision,
  archived: z.boolean(),
  updatedAt: date,
  document: z.object({
    name: z.string().trim().min(1).max(80),
    chain: z.string().min(1).max(20),
    addresses: z.array(address).min(1).max(20),
    tokens: z.array(address).min(1).max(10),
    amount,
    amountMax: amount.optional(),
    amounts: z.array(z.array(amount).min(1).max(20)).min(1).max(20).optional(),
    feeReserve: amount,
    cycles: z.number().int().min(1).max(20),
    intervalMinutes: z.number().int().min(0).max(10080).optional(),
    intervalSeconds: z.number().int().min(0).max(604800).optional(),
    startAt: date,
    walletRevisions: z.array(z.object({ address, revision })).min(1).max(20),
    totalBudget: z.string().regex(/^\d{1,18}(?:\.\d{1,18})?$/),
  }),
});

/** Historical display admission only. This grants no preparation or signing authority. */
export function readSavedWarmupDisplay(
  value: unknown,
  id: string,
): SavedWarmup {
  try {
    const { plan } = z.object({ plan: saved }).parse(value);
    if (plan.id !== id) throw Error();
    const d = plan.document;
    // Display arithmetic has no current scheduling, supported-network or runtime
    // rules. Old/archived configurations are evidence, not fresh executable plans.
    const atoms = (value: string) => {
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
    };
    const lower = atoms(d.amount),
      reserve = atoms(d.feeReserve);
    if (lower === 0n || reserve === 0n) throw Error();
    let buys: bigint;
    if (d.amountMax !== undefined) {
      const upper = atoms(d.amountMax);
      if (
        upper <= lower ||
        !d.amounts ||
        d.amounts.length !== d.addresses.length
      )
        throw Error();
      buys = d.amounts.reduce((total, row) => {
        if (row.length !== d.cycles) throw Error();
        return (
          total +
          row.reduce((sum, value) => {
            const raw = atoms(value);
            if (raw < lower || raw > upper) throw Error();
            return sum + raw;
          }, 0n)
        );
      }, 0n);
    } else {
      if (d.amounts !== undefined) throw Error();
      buys = lower * BigInt(d.cycles) * BigInt(d.addresses.length);
    }
    if (
      atoms(d.totalBudget) !== buys + reserve * BigInt(d.addresses.length) ||
      (d.intervalMinutes === undefined && d.intervalSeconds === undefined) ||
      new Set(d.addresses).size !== d.addresses.length ||
      new Set(d.tokens).size !== d.tokens.length ||
      d.walletRevisions.length !== d.addresses.length ||
      new Set(d.walletRevisions.map((w) => w.address)).size !==
        d.addresses.length ||
      d.walletRevisions.some((w) => !d.addresses.includes(w.address))
    )
      throw Error();
    return plan;
  } catch {
    throw Error(
      'Saved warmup details do not match this plan. Reload to try again.',
    );
  }
}
