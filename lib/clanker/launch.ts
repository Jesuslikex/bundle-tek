import { Clanker } from 'clanker-sdk/v4';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

// Clanker v4.0.0 factory on Base, from the official deployed-contracts page
// (clanker.gitbook.io/.../deployed-contracts). The SDK's transaction must
// target exactly this address.
export const CLANKER_V4_FACTORY_BASE: Address =
  '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
export const BASE_CHAIN_ID = 8453;

export type ClankerDraft = {
  name: string;
  symbol: string;
  image: string;
  admin: string;
};

export type WalletCall = {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
};

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
  return { name, symbol, image, admin: getAddress(draft.admin) };
}

/** Builds the unsigned deployToken call with the official Clanker SDK. */
export async function clankerDeployCall(
  draft: ClankerDraft,
  sdk: Pick<Clanker, 'getDeployTransaction'> = new Clanker({}),
): Promise<WalletCall> {
  const d = validateClankerDraft(draft);
  const tx = await sdk.getDeployTransaction({
    name: d.name,
    symbol: d.symbol,
    image: d.image,
    tokenAdmin: d.admin,
    chainId: BASE_CHAIN_ID,
  });
  if (getAddress(tx.address) !== CLANKER_V4_FACTORY_BASE)
    throw new Error('Clanker SDK returned an unexpected factory address.');
  if (tx.chainId !== undefined && tx.chainId !== BASE_CHAIN_ID)
    throw new Error('Clanker SDK returned a transaction for another chain.');
  const value = tx.value ?? 0n;
  if (value !== 0n) throw new Error('Unexpected ETH value on Clanker deploy.');
  return {
    from: d.admin,
    to: CLANKER_V4_FACTORY_BASE,
    data: encodeFunctionData({
      abi: tx.abi,
      functionName: tx.functionName,
      args: tx.args,
    } as Parameters<typeof encodeFunctionData>[0]),
    value,
    chainId: BASE_CHAIN_ID,
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
