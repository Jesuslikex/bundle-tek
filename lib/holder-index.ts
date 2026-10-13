import { walletAddress } from './wallet-workspace';
import { percentOfSupply } from './supply-analysis';
import {
  holderExtensionNames,
  sameHolderMintFees,
  validateHolderMintObservation,
  type HolderMintObservation,
} from './holder-index-mint';

export const HOLDER_INDEX_PAGE_SIZE = 1000;
export const HOLDER_INDEX_MAX_PAGES = 500;
export const HOLDER_RUN_RESUME_MS = 5 * 60_000;
const uint = (value: unknown, max = (1n << 64n) - 1n) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid indexed integer.');
  return value;
};
const slot = (value: unknown) =>
  Number(uint(value, BigInt(Number.MAX_SAFE_INTEGER)));
export type HolderIndexAccount = {
  address: string;
  owner: string;
  raw: string;
  frozen: boolean;
  withheldRaw?: string;
  extensions?: string[];
};
export type HolderIndexPage = {
  enumeration?: 'program-accounts-v2' | 'das-cursor';
  requestedCursor?: string | null;
  nextCursor?: string | null;
  tokenProgram?: string;
  mintObservation?: HolderMintObservation;
  mint: string;
  page: number;
  decimals: number;
  totalSupplyRaw: string;
  supplySlot: number;
  indexedSlot: number;
  observedAt: string;
  source: string;
  accounts: HolderIndexAccount[];
};

export function decodeHolderIndexPage(
  result: unknown,
  supply: unknown,
  mint: string,
  page: number,
  source: string,
): HolderIndexPage {
  const data = result as {
    last_indexed_slot?: unknown;
    token_accounts?: Array<{
      address?: unknown;
      owner?: unknown;
      mint?: unknown;
      amount?: unknown;
      frozen?: unknown;
      withheldRaw?: unknown;
      extensions?: unknown;
    }>;
  };
  const token = supply as {
    context?: { slot?: unknown };
    value?: { amount?: unknown; decimals?: unknown };
  };
  const totalSupplyRaw = uint(token?.value?.amount);
  if (
    totalSupplyRaw === '0' ||
    !Array.isArray(data?.token_accounts) ||
    data.token_accounts.length > HOLDER_INDEX_PAGE_SIZE
  )
    throw new Error('Indexed holder data unavailable.');
  const seen = new Set<string>();
  const accounts = data.token_accounts.map((account) => {
    const address = walletAddress(account.address, 'Solana');
    const owner = walletAddress(account.owner, 'Solana');
    if (
      seen.has(address) ||
      account.mint !== mint ||
      typeof account.frozen !== 'boolean'
    )
      throw new Error('Indexed account scope differs.');
    seen.add(address);
    return {
      address,
      owner,
      raw: uint(account.amount),
      frozen: account.frozen,
      ...(account.withheldRaw !== undefined
        ? { withheldRaw: uint(account.withheldRaw) }
        : {}),
      ...(account.extensions !== undefined
        ? { extensions: holderExtensionNames(account.extensions) }
        : {}),
    };
  });
  return {
    mint,
    page,
    source,
    accounts,
    totalSupplyRaw,
    decimals: Number(uint(token?.value?.decimals, 255n)),
    supplySlot: slot(token?.context?.slot),
    indexedSlot: slot(data.last_indexed_slot),
    observedAt: new Date().toISOString(),
  };
}

export type HolderIndexScan = {
  enumeration?: 'program-accounts-v2' | 'das-cursor';
  nextCursor?: string | null;
  tokenProgram?: string;
  mintObservation?: HolderMintObservation;
  minMintSlot?: number;
  maxMintSlot?: number;
  mint: string;
  decimals: number;
  totalSupplyRaw: string;
  source: string;
  pages: number;
  accounts: Map<string, HolderIndexAccount>;
  owners: Map<string, { owner: string; raw: bigint; accountCount: number }>;
  indexedRaw: bigint;
  minIndexedSlot: number;
  maxIndexedSlot: number;
  minSupplySlot: number;
  maxSupplySlot: number;
  firstObservedAt: string;
  lastObservedAt: string;
  status: 'partial' | 'enumerated' | 'limit';
};

/** Reject before committing a page, so retries cannot corrupt accumulated totals. */
export function appendHolderIndexPage(
  previous: HolderIndexScan | null,
  page: HolderIndexPage,
  mint: string,
  decimals: number,
): HolderIndexScan {
  if (page.enumeration) {
    if (
      typeof page.tokenProgram !== 'string' ||
      page.requestedCursor !== (previous?.nextCursor ?? null) ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' ||
          !page.nextCursor ||
          page.nextCursor.length > 512 ||
          page.nextCursor === page.requestedCursor)) ||
      (previous &&
        (previous.enumeration !== page.enumeration ||
          previous.tokenProgram !== page.tokenProgram))
    )
      throw new Error(
        'Holder cursor or token program changed. Start a fresh scan.',
      );
  } else if (previous?.enumeration)
    throw new Error('Holder enumeration method changed.');
  if (page.mintObservation) {
    validateHolderMintObservation(page.mintObservation);
    if (
      page.tokenProgram !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
      page.mintObservation.slot < page.supplySlot
    )
      throw new Error('Holder mint observation provenance differs.');
  }
  if (
    previous &&
    !sameHolderMintFees(previous.mintObservation, page.mintObservation)
  )
    throw new Error('Mint fees or extensions changed. Start a fresh scan.');
  if (
    page.mint !== mint ||
    page.decimals !== decimals ||
    page.page !== (previous?.pages ?? 0) + 1 ||
    page.page > HOLDER_INDEX_MAX_PAGES ||
    (previous &&
      (previous.status !== 'partial' ||
        previous.totalSupplyRaw !== page.totalSupplyRaw ||
        previous.source !== page.source))
  )
    throw new Error('Holder index context changed. Start a fresh scan.');
  // Browser response validation is independent of the provider decoder.
  uint(page.totalSupplyRaw);
  if (
    page.totalSupplyRaw === '0' ||
    !Number.isSafeInteger(page.indexedSlot) ||
    page.indexedSlot < 0 ||
    !Number.isSafeInteger(page.supplySlot) ||
    page.supplySlot < 0 ||
    !Number.isFinite(Date.parse(page.observedAt)) ||
    typeof page.source !== 'string' ||
    !/^[a-zA-Z0-9.-]{1,253}$/.test(page.source) ||
    !Array.isArray(page.accounts) ||
    page.accounts.length > HOLDER_INDEX_PAGE_SIZE
  )
    throw new Error('Invalid holder index page.');
  const seen = new Set<string>();
  let addition = 0n;
  for (const account of page.accounts) {
    walletAddress(account.address, 'Solana');
    walletAddress(account.owner, 'Solana');
    if (
      seen.has(account.address) ||
      previous?.accounts.has(account.address) ||
      typeof account.frozen !== 'boolean'
    )
      throw new Error(
        'Holder pages overlap. The index changed; start a fresh scan.',
      );
    seen.add(account.address);
    addition += BigInt(uint(account.raw));
    if (account.withheldRaw !== undefined) {
      uint(account.withheldRaw);
      if (
        page.tokenProgram !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
        page.enumeration !== 'program-accounts-v2'
      )
        throw new Error('Withheld fee account provenance differs.');
    }
    if (account.extensions !== undefined) {
      const extensions = holderExtensionNames(account.extensions);
      if (
        page.tokenProgram !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ||
        page.enumeration !== 'program-accounts-v2' ||
        extensions.includes('transferFeeAmount') !==
          (account.withheldRaw !== undefined)
      )
        throw new Error('Holder account extension provenance differs.');
    }
  }
  const indexedRaw = (previous?.indexedRaw ?? 0n) + addition;
  if (indexedRaw > BigInt(page.totalSupplyRaw))
    throw new Error('Indexed balances exceed supply. Start a fresh scan.');
  const accounts = new Map(previous?.accounts),
    owners = new Map(previous?.owners);
  for (const account of page.accounts) {
    accounts.set(account.address, account);
    const before = owners.get(account.owner);
    owners.set(account.owner, {
      owner: account.owner,
      raw: (before?.raw ?? 0n) + BigInt(account.raw),
      accountCount: (before?.accountCount ?? 0) + 1,
    });
  }
  return {
    mint,
    decimals,
    ...(page.enumeration
      ? {
          enumeration: page.enumeration,
          nextCursor: page.nextCursor,
          tokenProgram: page.tokenProgram,
        }
      : {}),
    totalSupplyRaw: page.totalSupplyRaw,
    source: page.source,
    pages: page.page,
    accounts,
    owners,
    indexedRaw,
    ...(page.mintObservation
      ? {
          mintObservation: page.mintObservation,
          minMintSlot: Math.min(
            previous?.minMintSlot ?? page.mintObservation.slot,
            page.mintObservation.slot,
          ),
          maxMintSlot: Math.max(
            previous?.maxMintSlot ?? page.mintObservation.slot,
            page.mintObservation.slot,
          ),
        }
      : {}),
    minIndexedSlot: Math.min(
      previous?.minIndexedSlot ?? page.indexedSlot,
      page.indexedSlot,
    ),
    maxIndexedSlot: Math.max(
      previous?.maxIndexedSlot ?? page.indexedSlot,
      page.indexedSlot,
    ),
    minSupplySlot: Math.min(
      previous?.minSupplySlot ?? page.supplySlot,
      page.supplySlot,
    ),
    maxSupplySlot: Math.max(
      previous?.maxSupplySlot ?? page.supplySlot,
      page.supplySlot,
    ),
    firstObservedAt: previous?.firstObservedAt ?? page.observedAt,
    lastObservedAt: page.observedAt,
    status: (
      page.enumeration ? page.nextCursor === null : page.accounts.length === 0
    )
      ? 'enumerated'
      : page.page === HOLDER_INDEX_MAX_PAGES
        ? 'limit'
        : 'partial',
  };
}

export function holderIndexSummary(scan: HolderIndexScan) {
  const holders = [...scan.owners.values()]
    .filter((owner) => owner.raw > 0n)
    .toSorted((a, b) =>
      a.raw === b.raw ? a.owner.localeCompare(b.owner) : a.raw > b.raw ? -1 : 1,
    );
  const top10Raw = holders
    .slice(0, 10)
    .reduce((sum, holder) => sum + holder.raw, 0n);
  return {
    holders,
    top10Percent: percentOfSupply(top10Raw, BigInt(scan.totalSupplyRaw)),
    coveredPercent: percentOfSupply(
      scan.indexedRaw,
      BigInt(scan.totalSupplyRaw),
    ),
    remainderRaw: (BigInt(scan.totalSupplyRaw) - scan.indexedRaw).toString(),
  };
}
