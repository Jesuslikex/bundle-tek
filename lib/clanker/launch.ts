import { Clanker } from 'clanker-sdk/v4';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem';

// Clanker v4.0.0 factory on Base, from the official deployed-contracts page
// (clanker.gitbook.io/.../deployed-contracts). The SDK's transaction must
// target exactly this address.
export const CLANKER_V4_FACTORY_BASE: Address =
  '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
// Vault and ETH dev-buy extensions on Base, as pinned in clanker-sdk 4.2.19.
export const CLANKER_V4_VAULT_BASE: Address =
  '0x8E845EAd15737bF71904A30BdDD3aEE76d6ADF6C';
export const CLANKER_V4_DEVBUY_BASE: Address =
  '0x1331f0788F9c08C8F38D52c7a1152250A9dE00be';
// Bankr launches are Clanker v4 deploys tagged with the Bankr interface and an
// 80/20 creator/Bankr fee split, per Bankr's own skill repository
// (github.com/bankrbot/openclaw-skills, clanker/SKILL.md).
export const BANKR_INTERFACE_ADDRESS: Address =
  '0xF60633D02690e2A15A54AB919925F3d038Df163e';
export const BANKR_INTERFACE_BPS = 2000;
export const BASE_CHAIN_ID = 8453;
export const CLANKER_MAX_DEV_BUY_WEI = parseEther('5');
export const CLANKER_MIN_VAULT_DAYS = 7;
export const CLANKER_MAX_VAULT_DAYS = 3650;
const DAY_SECONDS = 86_400;

export type ClankerInterface = 'Clanker' | 'Bankr';

export type ClankerDraft = {
  name: string;
  symbol: string;
  image: string;
  admin: string;
  venue?: ClankerInterface;
  /** ETH spent on a dev buy in the deploy transaction; empty for none. */
  devBuyEth?: string;
  /** Whole percent of supply locked in the Clanker vault; empty for none. */
  vaultPercent?: string;
  /** Vault lockup in whole days. */
  vaultDays?: string;
};

export type ClankerReward = { recipient: Address; admin: Address; bps: number };

export type ClankerLaunchSummary = {
  venue: ClankerInterface;
  devBuyWei: bigint;
  vault: { percent: number; days: number } | null;
  rewards: ClankerReward[];
};

export type WalletCall = {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
};

function wholeNumber(value: string, label: string, min: number, max: number) {
  if (!/^\d{1,4}$/.test(value))
    throw new Error(`${label} must be a whole number.`);
  const n = Number(value);
  if (n < min || n > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}

export function validateClankerDraft(draft: ClankerDraft) {
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  if (!name || name.length > 64)
    throw new Error('Token name is required (max 64).');
  if (!/^[A-Za-z0-9]{1,16}$/.test(symbol))
    throw new Error('Ticker must be 1-16 letters or digits.');
  const image = draft.image.trim();
  if (image && !/^(https:\/\/|ipfs:\/\/)\S+$/.test(image))
    throw new Error('Image must be an https:// or ipfs:// link.');
  const venue = draft.venue ?? 'Clanker';
  if (venue !== 'Clanker' && venue !== 'Bankr')
    throw new Error('Unsupported Base launch interface.');
  const admin = getAddress(draft.admin);

  const buy = (draft.devBuyEth ?? '').trim();
  let devBuyWei = 0n;
  if (buy) {
    if (!/^\d+(\.\d{1,6})?$/.test(buy))
      throw new Error('Dev buy must be an ETH amount with up to 6 decimals.');
    devBuyWei = parseEther(buy);
    if (devBuyWei <= 0n) throw new Error('Dev buy must be above 0 ETH.');
    if (devBuyWei > CLANKER_MAX_DEV_BUY_WEI)
      throw new Error(
        `Dev buy is capped at ${formatEther(CLANKER_MAX_DEV_BUY_WEI)} ETH.`,
      );
  }

  const pct = (draft.vaultPercent ?? '').trim();
  let vault: ClankerLaunchSummary['vault'] = null;
  if (pct && pct !== '0') {
    const percent = wholeNumber(pct, 'Vault percent', 1, 90);
    const days = wholeNumber(
      (draft.vaultDays ?? '').trim(),
      'Vault lockup days',
      CLANKER_MIN_VAULT_DAYS,
      CLANKER_MAX_VAULT_DAYS,
    );
    vault = { percent, days };
  }

  const rewards: ClankerReward[] =
    venue === 'Bankr'
      ? [
          { recipient: admin, admin, bps: 10_000 - BANKR_INTERFACE_BPS },
          {
            recipient: BANKR_INTERFACE_ADDRESS,
            admin: BANKR_INTERFACE_ADDRESS,
            bps: BANKR_INTERFACE_BPS,
          },
        ]
      : [{ recipient: admin, admin, bps: 10_000 }];

  return { name, symbol, image, admin, venue, devBuyWei, vault, rewards };
}

type DeployArgs = {
  tokenConfig: {
    tokenAdmin: Address;
    name: string;
    symbol: string;
    image: string;
    context: string;
    originatingChainId: bigint;
  };
  lockerConfig: {
    rewardAdmins: readonly Address[];
    rewardRecipients: readonly Address[];
    rewardBps: readonly number[];
  };
  extensionConfigs: readonly {
    extension: Address;
    msgValue: bigint;
    extensionBps: number;
    extensionData: Hex;
  }[];
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Decodes the deploy calldata and checks it says exactly what the review
 * shows: token identity, admin, interface tag, fee recipients, dev buy value
 * and vault. Anything else (extra extensions, other recipients) refuses.
 */
export function verifyClankerDeploy(
  abi: Parameters<typeof decodeFunctionData>[0]['abi'],
  data: Hex,
  value: bigint,
  d: ReturnType<typeof validateClankerDraft>,
) {
  const decoded = decodeFunctionData({ abi, data });
  if (decoded.functionName !== 'deployToken')
    throw new Error('Clanker SDK returned an unexpected function.');
  const args = (decoded.args as readonly unknown[])[0] as DeployArgs;
  const t = args.tokenConfig;
  if (
    !same(t.tokenAdmin, d.admin) ||
    t.name !== d.name ||
    t.symbol !== d.symbol ||
    t.image !== d.image ||
    t.originatingChainId !== BigInt(BASE_CHAIN_ID)
  )
    throw new Error('Clanker deploy does not match the reviewed token.');
  let tag: unknown;
  try {
    tag = (JSON.parse(t.context) as { interface?: unknown }).interface;
  } catch {
    tag = undefined;
  }
  if (tag !== d.venue)
    throw new Error('Clanker deploy has the wrong interface tag.');

  const l = args.lockerConfig;
  if (
    l.rewardRecipients.length !== d.rewards.length ||
    d.rewards.some(
      (r, i) =>
        !same(l.rewardRecipients[i], r.recipient) ||
        !same(l.rewardAdmins[i], r.admin) ||
        Number(l.rewardBps[i]) !== r.bps,
    )
  )
    throw new Error('Clanker deploy fee recipients do not match the review.');

  let vaultSeen = false;
  let buySeen = false;
  let msgTotal = 0n;
  for (const ext of args.extensionConfigs) {
    msgTotal += ext.msgValue;
    if (same(ext.extension, CLANKER_V4_VAULT_BASE) && d.vault && !vaultSeen) {
      const expected = encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
        [d.admin, BigInt(d.vault.days * DAY_SECONDS), 0n],
      );
      if (
        ext.msgValue !== 0n ||
        Number(ext.extensionBps) !== d.vault.percent * 100 ||
        !same(ext.extensionData, expected)
      )
        throw new Error('Clanker vault does not match the review.');
      vaultSeen = true;
    } else if (
      same(ext.extension, CLANKER_V4_DEVBUY_BASE) &&
      d.devBuyWei > 0n &&
      !buySeen
    ) {
      // Dev buy data ends with the token recipient, which must be the admin.
      if (
        ext.msgValue !== d.devBuyWei ||
        Number(ext.extensionBps) !== 0 ||
        !ext.extensionData
          .toLowerCase()
          .endsWith(d.admin.slice(2).toLowerCase())
      )
        throw new Error('Clanker dev buy does not match the review.');
      buySeen = true;
    } else {
      throw new Error('Clanker deploy includes an unexpected extension.');
    }
  }
  if (Boolean(d.vault) !== vaultSeen || d.devBuyWei > 0n !== buySeen)
    throw new Error('Clanker deploy is missing a reviewed extension.');
  if (msgTotal !== value || value !== d.devBuyWei)
    throw new Error('Clanker deploy ETH value does not match the dev buy.');
}

/** Builds the unsigned deployToken call with the official Clanker SDK. */
export async function clankerDeployCall(
  draft: ClankerDraft,
  sdk: Pick<Clanker, 'getDeployTransaction'> = new Clanker({}),
): Promise<WalletCall & { summary: ClankerLaunchSummary }> {
  const d = validateClankerDraft(draft);
  const tx = await sdk.getDeployTransaction({
    name: d.name,
    symbol: d.symbol,
    image: d.image,
    tokenAdmin: d.admin,
    chainId: BASE_CHAIN_ID,
    context: { interface: d.venue },
    rewards: {
      recipients: d.rewards.map((r) => ({
        ...r,
        token: d.venue === 'Bankr' ? ('Paired' as const) : ('Both' as const),
      })),
    },
    ...(d.devBuyWei > 0n
      ? { devBuy: { ethAmount: Number(formatEther(d.devBuyWei)) } }
      : {}),
    ...(d.vault
      ? {
          vault: {
            percentage: d.vault.percent,
            lockupDuration: d.vault.days * DAY_SECONDS,
            vestingDuration: 0,
          },
        }
      : {}),
  });
  if (getAddress(tx.address) !== CLANKER_V4_FACTORY_BASE)
    throw new Error('Clanker SDK returned an unexpected factory address.');
  if (tx.chainId !== undefined && tx.chainId !== BASE_CHAIN_ID)
    throw new Error('Clanker SDK returned a transaction for another chain.');
  const value = tx.value ?? 0n;
  const data = encodeFunctionData({
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args,
  } as Parameters<typeof encodeFunctionData>[0]);
  verifyClankerDeploy(tx.abi as never, data, value, d);
  return {
    from: d.admin,
    to: CLANKER_V4_FACTORY_BASE,
    data,
    value,
    chainId: BASE_CHAIN_ID,
    summary: {
      venue: d.venue,
      devBuyWei: d.devBuyWei,
      vault: d.vault,
      rewards: d.rewards,
    },
  };
}

export function walletRequestParams(call: WalletCall) {
  return [
    {
      from: call.from,
      to: call.to,
      data: call.data,
      value: '0x' + call.value.toString(16),
    },
  ];
}
