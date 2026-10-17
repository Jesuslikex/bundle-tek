import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';

// Proxima-style Send Tokens: amounts are percentages of total supply, split
// across the selected source wallets. Each leg is one wallet -> one recipient
// transfer that still goes through its own reviewed withdrawal approval.
export const SEND_PERCENT_SCALE = 1_000_000n; // 100% = 1,000,000 ppm
export const MAX_SEND_ROWS = 50;
export const MAX_SEND_LEGS = 50;

export type SendRow = { sender?: string; recipient: string; ppm: bigint };
export type SendSource = { address: string; raw: bigint };
export type SendLeg = {
  sender: string;
  recipient: string;
  raw: string;
  amount: string;
};
export type SendPlan = {
  supplyRaw: string;
  decimals: number;
  totalRaw: string;
  legs: SendLeg[];
  usage: { address: string; usedRaw: string; remainingRaw: string }[];
};

/** Parse a percentage of total supply with at most four decimals, in (0, 100]. */
export function sendPercent(value: unknown) {
  if (typeof value !== 'string') throw new Error('Enter a supply percentage.');
  const text = value.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(text))
    throw new Error('Use a supply percentage with at most four decimals.');
  const [whole, fraction = ''] = text.split('.');
  const ppm = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (ppm < 1n || ppm > SEND_PERCENT_SCALE)
    throw new Error('Supply percentage must be above 0 and at most 100.');
  return ppm;
}

export function formatSendPercent(ppm: bigint) {
  const whole = ppm / 10_000n,
    fraction = (ppm % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

/** Bulk Add: one entry per line, `recipient,%` or `sender,recipient,%`; comma, colon or tab separated. */
export function parseSendRows(text: string): SendRow[] {
  if (typeof text !== 'string' || text.length > 20_000)
    throw new Error('Bulk entries are too long.');
  const rows: SendRow[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const fields = line.split(/[,:\t]/).map((f) => f.trim());
    try {
      if (fields.length === 2)
        rows.push({
          recipient: walletAddress(fields[0], 'Solana'),
          ppm: sendPercent(fields[1]),
        });
      else if (fields.length === 3)
        rows.push({
          sender: walletAddress(fields[0], 'Solana'),
          recipient: walletAddress(fields[1], 'Solana'),
          ppm: sendPercent(fields[2]),
        });
      else
        throw new Error(
          'Use recipient,percentage or sender,recipient,percentage.',
        );
    } catch (error) {
      throw new Error(
        `Line ${index + 1}: ${error instanceof Error ? error.message : 'invalid entry.'}`,
      );
    }
  });
  if (rows.length === 0) throw new Error('Add at least one recipient.');
  if (rows.length > MAX_SEND_ROWS)
    throw new Error(`Use at most ${MAX_SEND_ROWS} recipients per send.`);
  return rows;
}

/**
 * Allocate every row against the selected sources. Rows that name a sender draw
 * from that wallet only; other rows draw from the largest remaining balances
 * first. Refuses (never partially fills) when the sources can't cover a row.
 */
export function planTokenSend(input: {
  supplyRaw: bigint;
  decimals: number;
  sources: SendSource[];
  rows: SendRow[];
}): SendPlan {
  const { supplyRaw, decimals, rows } = input;
  if (supplyRaw < 1n || supplyRaw > (1n << 64n) - 1n)
    throw new Error('Token supply is unavailable.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error('Token precision is unavailable.');
  if (input.sources.length === 0) throw new Error('Choose source wallets.');
  const remaining = new Map<string, bigint>();
  const order: string[] = [];
  for (const s of input.sources) {
    if (remaining.has(s.address)) throw new Error('Duplicate source wallet.');
    if (s.raw < 0n) throw new Error('Invalid source balance.');
    remaining.set(s.address, s.raw);
    order.push(s.address);
  }
  const legs = new Map<string, bigint>();
  const add = (sender: string, recipient: string, raw: bigint) => {
    const key = sender + '>' + recipient;
    legs.set(key, (legs.get(key) ?? 0n) + raw);
  };
  const sorted = [
    ...rows.filter((r) => r.sender),
    ...rows.filter((r) => !r.sender),
  ];
  let total = 0n;
  for (const row of sorted) {
    if (remaining.has(row.recipient))
      throw new Error(
        'A recipient is also a selected source wallet. Remove it from one side.',
      );
    const raw = (supplyRaw * row.ppm) / SEND_PERCENT_SCALE;
    if (raw < 1n)
      throw new Error(
        `${formatSendPercent(row.ppm)} of supply is below one token unit.`,
      );
    total += raw;
    if (row.sender) {
      const balance = remaining.get(row.sender);
      if (balance === undefined)
        throw new Error('A bulk entry names a sender that is not selected.');
      if (balance < raw)
        throw new Error(
          `Sender ${row.sender} does not hold ${formatSendPercent(row.ppm)} of supply.`,
        );
      remaining.set(row.sender, balance - raw);
      add(row.sender, row.recipient, raw);
      continue;
    }
    let need = raw;
    const candidates = order
      .filter((a) => remaining.get(a)! > 0n)
      .sort((a, b) => {
        const d = remaining.get(b)! - remaining.get(a)!;
        return d > 0n ? 1 : d < 0n ? -1 : order.indexOf(a) - order.indexOf(b);
      });
    for (const sender of candidates) {
      if (need === 0n) break;
      const take =
        remaining.get(sender)! < need ? remaining.get(sender)! : need;
      remaining.set(sender, remaining.get(sender)! - take);
      add(sender, row.recipient, take);
      need -= take;
    }
    if (need > 0n)
      throw new Error(
        'Selected wallets do not hold enough supply for this send.',
      );
  }
  if (legs.size > MAX_SEND_LEGS)
    throw new Error(
      `This send needs ${legs.size} transfers. Use at most ${MAX_SEND_LEGS}.`,
    );
  return {
    supplyRaw: supplyRaw.toString(),
    decimals,
    totalRaw: total.toString(),
    legs: [...legs].map(([key, raw]) => {
      const [sender, recipient] = key.split('>');
      return {
        sender,
        recipient,
        raw: raw.toString(),
        amount: formatNativeBalance(raw.toString(), decimals),
      };
    }),
    usage: order.map((address) => {
      const start = input.sources.find((s) => s.address === address)!.raw;
      return {
        address,
        usedRaw: (start - remaining.get(address)!).toString(),
        remainingRaw: remaining.get(address)!.toString(),
      };
    }),
  };
}
