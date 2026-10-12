import { validateTokenSource } from './token-source';
import type { ImportedToken } from './token-import';
import { walletAddress } from './wallet-workspace';
import { warmupAtoms } from './wallet-warmup';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';

export function importedTokenDocument(
  input: unknown,
  observation: ImportedToken,
) {
  const source = validateTokenSource(input);
  if (
    observation.chain !== source.chain ||
    observation.address !== source.address ||
    typeof observation.name !== 'string' ||
    !observation.name.trim() ||
    observation.name.length > 256 ||
    typeof observation.symbol !== 'string' ||
    !observation.symbol.trim() ||
    observation.symbol.length > 64 ||
    !Number.isInteger(observation.decimals) ||
    observation.decimals < 0 ||
    observation.decimals > 255 ||
    typeof observation.totalSupplyRaw !== 'string' ||
    !/^(0|[1-9]\d{0,77})$/.test(observation.totalSupplyRaw) ||
    BigInt(observation.totalSupplyRaw) >
      (1n << (source.chain === 'Solana' ? 64n : 256n)) - 1n ||
    [observation.contextSlot, observation.blockNumber].some(
      (value) =>
        value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    typeof observation.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(observation.observedAt))
  )
    throw new Error('Imported identity does not match the requested token.');
  const url = new URL(observation.source);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Invalid identity source.');
  return {
    format: 'imported-token-project-v1' as const,
    executionAllowed: false as const,
    token: {
      ...source,
      name: observation.name,
      symbol: observation.symbol,
      decimals: observation.decimals,
      totalSupplyRaw: observation.totalSupplyRaw,
      observedAt: observation.observedAt,
      source: url.hostname,
      ...(observation.contextSlot !== undefined
        ? { contextSlot: observation.contextSlot }
        : {}),
      ...(observation.blockNumber !== undefined
        ? { blockNumber: observation.blockNumber }
        : {}),
      ...(observation.metadataKind
        ? { metadataKind: observation.metadataKind }
        : {}),
      ...(observation.tokenProgram
        ? { tokenProgram: observation.tokenProgram }
        : {}),
    },
  };
}
export type ImportedTradeSettings = {
  side: 'Buy' | 'Sell';
  amount: string;
  wallet: string;
  walletRevision: number;
};
export type ImportedTokenDocument = ReturnType<typeof importedTokenDocument> & {
  tradeSettings?: ImportedTradeSettings;
};
export function importedTradeSettings(
  value: unknown,
  token: ImportedTokenDocument['token'],
): ImportedTradeSettings {
  const input = value as Record<string, unknown> | null;
  if (
    token.chain !== 'Solana' ||
    !input ||
    !['Buy', 'Sell'].includes(String(input.side)) ||
    !Number.isSafeInteger(input.walletRevision) ||
    Number(input.walletRevision) < 1 ||
    Number(input.walletRevision) > 1000000000
  )
    throw new Error('Invalid trade settings.');
  const side = input.side as 'Buy' | 'Sell';
  const decimals = side === 'Buy' ? 9 : token.decimals;
  const raw =
    side === 'Buy'
      ? warmupAtoms(input.amount, 9)
      : solanaTokenAtoms(input.amount, decimals);
  if (raw > (1n << 64n) - 1n) throw new Error('Amount exceeds Solana units.');
  return {
    side,
    amount: formatNativeBalance(raw.toString(), decimals),
    wallet: walletAddress(input.wallet, 'Solana'),
    walletRevision: Number(input.walletRevision),
  };
}
export type ImportedTokenProject = {
  id: string;
  revision: number;
  archived: boolean;
  updatedAt: string;
  document: ImportedTokenDocument;
};

export type ImportedTokenEvent = {
  id: string;
  projectId: string;
  type:
    | 'project.import'
    | 'project.refresh'
    | 'project.settings'
    | 'project.archive'
    | 'project.restore';
  revision: number;
  document: ImportedTokenDocument;
  createdAt: string;
};
export type ImportedActivityEvent = Omit<ImportedTokenEvent, 'document'> & {
  token: Pick<
    ImportedTokenDocument['token'],
    'name' | 'symbol' | 'chain' | 'address'
  >;
};
