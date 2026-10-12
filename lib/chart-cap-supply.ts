import type { PoolCandles } from './pool-candles';
export type ChartSupply = {
  chain: string;
  address: string;
  decimals: number;
  totalSupplyRaw: string;
  observedAt: string;
};
export function chartCapSupply(snapshot: PoolCandles, token?: ChartSupply) {
  if (
    !token ||
    token.chain !== snapshot.chain ||
    token.address !== snapshot.address ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255 ||
    typeof token.totalSupplyRaw !== 'string' ||
    !/^[1-9]\d{0,77}$/.test(token.totalSupplyRaw) ||
    BigInt(token.totalSupplyRaw) >
      (1n << (token.chain === 'Solana' ? 64n : 256n)) - 1n ||
    typeof token.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(token.observedAt))
  )
    return null;
  const supply = Number(token.totalSupplyRaw) / 10 ** token.decimals;
  if (
    !Number.isFinite(supply) ||
    supply <= 0 ||
    snapshot.candles.some((c) =>
      [c.open, c.high, c.low, c.close].some(
        (price) =>
          !Number.isFinite(price * supply) ||
          (price > 0 && price * supply === 0),
      ),
    )
  )
    return null;
  return supply;
}
