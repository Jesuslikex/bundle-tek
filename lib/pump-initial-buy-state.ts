import bs58 from 'bs58';
import schema from './pump-initial-buy-state-schema.json';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
type Kind = string | { defined?: { name: string }; vec?: Kind };
type Definition = {
  name: string;
  type: { fields: Array<{ name: string; type: Kind }> };
};
export function decodePumpInitialBuyState(
  name: 'FeeConfig' | 'UserVolumeAccumulator',
  bytes: Uint8Array,
) {
  const discriminator = schema.accounts.find(
    (account) => account.name === name,
  )!.discriminator;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 8 ||
    bytes.length > 200000 ||
    discriminator.some((byte, index) => bytes[index] !== byte)
  )
    throw new Error('Pump initial buy account discriminator differs.');
  let offset = 8;
  const take = (size: number) => {
    if (offset + size > bytes.length)
      throw new Error('Truncated Pump initial buy state.');
    const value = bytes.slice(offset, offset + size);
    offset += size;
    return value;
  };
  function read(kind: Kind, depth = 0): unknown {
    if (depth > 8) throw new Error('Pump initial buy state nesting differs.');
    if (kind === 'pubkey') return bs58.encode(take(32));
    if (kind === 'u8' || kind === 'bool') {
      const value = take(1)[0];
      if (kind === 'bool' && value > 1)
        throw new Error('Invalid Pump initial buy boolean.');
      return kind === 'bool' ? value === 1 : value;
    }
    if (kind === 'u64' || kind === 'i64') {
      const view = new DataView(take(8).buffer);
      return kind === 'u64'
        ? view.getBigUint64(0, true)
        : view.getBigInt64(0, true);
    }
    if (kind === 'u128') {
      const view = new DataView(take(16).buffer);
      return view.getBigUint64(0, true) + (view.getBigUint64(8, true) << 64n);
    }
    if (typeof kind === 'object' && kind.defined) {
      const type = (schema.types as unknown as Definition[]).find(
        (type) => type.name === kind.defined!.name,
      );
      if (!type) throw new Error('Unknown Pump initial buy type.');
      return Object.fromEntries(
        type.type.fields.map((field) => [
          field.name,
          read(field.type, depth + 1),
        ]),
      );
    }
    if (typeof kind === 'object' && kind.vec) {
      const count = new DataView(take(4).buffer).getUint32(0, true);
      if (count > 256)
        throw new Error('Pump fee schedule exceeds its supported bound.');
      return Array.from({ length: count }, () => read(kind.vec!, depth + 1));
    }
    throw new Error('Unsupported Pump initial buy field.');
  }
  const result = read({ defined: { name } }) as Record<string, unknown>;
  if (bytes.slice(offset).some((value) => value !== 0))
    throw new Error('Pump initial buy state contains unknown fields.');
  return result;
}
type Fees = {
  lp_fee_bps: bigint;
  protocol_fee_bps: bigint;
  creator_fee_bps: bigint;
};
type Tier = { market_cap_lamports_threshold: bigint; fees: Fees };
function fees(value: unknown): Fees {
  const fields = value as Fees;
  if (
    !fields ||
    ['lp_fee_bps', 'protocol_fee_bps', 'creator_fee_bps'].some(
      (key) =>
        typeof fields[key as keyof Fees] !== 'bigint' ||
        fields[key as keyof Fees] < 0n ||
        fields[key as keyof Fees] > 10000n,
    ) ||
    fields.protocol_fee_bps + fields.creator_fee_bps > 10000n
  )
    throw new Error('Pump initial buy fee rates differ.');
  return fields;
}
function tier(value: unknown, marketCap: bigint): Fees {
  const tiers = value as Tier[];
  if (
    !Array.isArray(tiers) ||
    !tiers.length ||
    tiers.length > 256 ||
    tiers.some(
      (entry, index) =>
        !entry ||
        typeof entry.market_cap_lamports_threshold !== 'bigint' ||
        entry.market_cap_lamports_threshold < 0n ||
        (index > 0 &&
          entry.market_cap_lamports_threshold <=
            tiers[index - 1].market_cap_lamports_threshold),
    )
  )
    throw new Error('Pump initial buy fee tiers differ.');
  for (const entry of tiers) fees(entry.fees);
  return fees(
    [...tiers]
      .reverse()
      .find((entry) => marketCap >= entry.market_cap_lamports_threshold)
      ?.fees ?? tiers[0].fees,
  );
}
function positivePumpAmount(raw: string) {
  if (
    typeof raw !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(raw) ||
    BigInt(raw) > (1n << 64n) - 1n
  )
    throw new Error('Pump initial buy reserve or amount differs.');
  return BigInt(raw);
}
export function pumpBuyFeeRates(input: {
  quoteMint: string;
  virtualTokensRaw: string;
  virtualQuoteRaw: string;
  feeConfig: Record<string, unknown>;
}) {
  const virtualTokens = positivePumpAmount(input.virtualTokensRaw),
    virtualQuote = positivePumpAmount(input.virtualQuoteRaw);
  const marketCap = (virtualQuote * 1000000000000000n) / virtualTokens;
  let selected: Fees;
  if (input.quoteMint === PUMP_NATIVE_QUOTE)
    selected = tier(input.feeConfig.fee_tiers, marketCap);
  else if (input.quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
    const stable = input.feeConfig.stable_fee_tiers;
    if (!Array.isArray(stable))
      throw new Error('Pump stable fee schedule differs.');
    selected = tier(
      stable.length ? stable : input.feeConfig.fee_tiers,
      marketCap,
    );
  } else {
    const exotic = fees(input.feeConfig.exotic_flat_fees);
    selected = Object.values(exotic).every((value) => value === 0n)
      ? fees(input.feeConfig.flat_fees)
      : exotic;
  }
  return {
    protocolFeeBps: selected.protocol_fee_bps,
    creatorFeeBps: selected.creator_fee_bps,
  };
}
/** Pinned official SDK 4.1.0 curve leg arithmetic. No synthetic migration or configurable creator rate. */
export function pumpInitialBuyPrice(input: {
  quoteMint: string;
  virtualTokensRaw: string;
  virtualQuoteRaw: string;
  tokenAmountRaw: string;
  feeConfig: Record<string, unknown>;
}) {
  const virtualTokens = positivePumpAmount(input.virtualTokensRaw),
    virtualQuote = positivePumpAmount(input.virtualQuoteRaw),
    amount = positivePumpAmount(input.tokenAmountRaw);
  if (amount >= virtualTokens)
    throw new Error('Initial buy must leave virtual tokens on the curve.');
  const selected = pumpBuyFeeRates(input);
  const principal = (virtualQuote * amount) / (virtualTokens - amount) + 1n;
  const fee = (bps: bigint) => (principal * bps + 9999n) / 10000n;
  const protocol = fee(selected.protocolFeeBps),
    creator = fee(selected.creatorFeeBps),
    total = principal + protocol + creator;
  if (total > (1n << 64n) - 1n)
    throw new Error('Initial buy quote cost exceeds u64.');
  return {
    principalRaw: principal.toString(),
    protocolFeeRaw: protocol.toString(),
    creatorFeeRaw: creator.toString(),
    totalQuoteCostRaw: total.toString(),
    protocolFeeBps: selected.protocolFeeBps.toString(),
    creatorFeeBps: selected.creatorFeeBps.toString(),
  };
}
