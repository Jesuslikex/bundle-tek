import type { TokenHolding } from './wallet-holdings';

export function holdingsTokenIdentity(value: unknown, holding: TokenHolding) {
  const token = value as Record<string, unknown> | null;
  if (
    !token ||
    token.chain !== 'Solana' ||
    token.address !== holding.mint ||
    token.tokenProgram !== holding.program ||
    token.decimals !== holding.decimals ||
    typeof token.name !== 'string' ||
    !token.name.trim() ||
    token.name.length > 256 ||
    typeof token.symbol !== 'string' ||
    !token.symbol.trim() ||
    token.symbol.length > 64 ||
    typeof token.totalSupplyRaw !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(token.totalSupplyRaw) ||
    BigInt(token.totalSupplyRaw) > (1n << 64n) - 1n ||
    typeof token.contextSlot !== 'number' ||
    !Number.isSafeInteger(token.contextSlot) ||
    token.contextSlot < 0 ||
    typeof token.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(token.observedAt)) ||
    typeof token.source !== 'string' ||
    !['Metaplex', 'Token-2022'].includes(String(token.metadataKind))
  )
    throw new Error(
      'Token identity does not match the observed holding. Refresh holdings and retry.',
    );
  let source: string;
  try {
    const url = new URL(token.source);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname
    )
      throw new Error();
    source = url.hostname;
  } catch {
    throw new Error('Token identity source is invalid.');
  }
  return {
    mint: holding.mint,
    name: token.name,
    symbol: token.symbol,
    decimals: holding.decimals,
    totalSupplyRaw: token.totalSupplyRaw,
    slot: token.contextSlot,
    observedAt: token.observedAt,
    source,
    metadataKind: String(token.metadataKind),
  };
}
export type HoldingsTokenIdentity = ReturnType<typeof holdingsTokenIdentity>;
