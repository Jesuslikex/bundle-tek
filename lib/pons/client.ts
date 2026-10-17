import { getAddress, parseEther, toHex, type Address, type Hex } from 'viem';

// Browser side of the Pons coordinator: builds the intent the server
// validates, and turns a handed-off unsigned envelope into wallet params.
// The wallet shows the exact transaction and the user confirms it.

export type PonsDraft = {
  name: string;
  symbol: string;
  description: string;
  logo: string;
  website: string;
  twitter: string;
  telegram: string;
  buyEth: string;
  maxTotalEth: string;
  maxGasEth: string;
  minTokensOut: string;
  creatorTaxBps: number;
};

export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function ponsIntent(draft: PonsDraft, wallet: string, salt: Hex) {
  const address = getAddress(wallet);
  const wei = (v: string, label: string) => {
    const value = parseEther(v.trim());
    if (value <= 0n) throw new Error(`${label} must be above zero.`);
    return value.toString();
  };
  if (!/^[1-9]\d{0,77}$/.test(draft.minTokensOut.trim()))
    throw new Error('Minimum tokens out must be a whole number above zero.');
  return {
    chainId: 4663,
    mode: 'single-recipient-atomic',
    wallet: address,
    recipient: address,
    creatorFeeRecipient: address,
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    logo: draft.logo.trim(),
    description: draft.description.trim(),
    socials: {
      twitter: draft.twitter.trim(),
      telegram: draft.telegram.trim(),
      discord: '',
      website: draft.website.trim(),
      farcaster: '',
    },
    creatorTaxBps: draft.creatorTaxBps,
    buybackEnabled: false,
    launchConfigId: '0',
    quoteInWei: wei(draft.buyEth, 'Initial buy'),
    maxTotalValueWei: wei(draft.maxTotalEth, 'Max total'),
    maxGasCostWei: wei(draft.maxGasEth, 'Max gas'),
    minTokensOut: draft.minTokensOut.trim(),
    salt,
    snipeTaxExemptions: [] as Address[],
  };
}

export type UnsignedEnvelope = {
  chainId: number;
  from: string;
  to: string;
  value: string;
  data: string;
  gas: string;
  gasPrice: string;
  nonce: number;
};

const hex = (decimal: string) => toHex(BigInt(decimal));

/** eth_sendTransaction params for the exact handed-off envelope. */
export function walletTransaction(tx: UnsignedEnvelope, account: string) {
  if (tx.chainId !== 4663) throw new Error('Envelope is not for Robinhood.');
  if (getAddress(tx.from) !== getAddress(account))
    throw new Error('Connected wallet differs from the launch wallet.');
  if (!/^0x[0-9a-fA-F]*$/.test(tx.data)) throw new Error('Bad calldata.');
  return {
    from: getAddress(tx.from),
    to: getAddress(tx.to),
    value: hex(tx.value),
    data: tx.data as Hex,
    gas: hex(tx.gas),
    gasPrice: hex(tx.gasPrice),
    nonce: toHex(tx.nonce),
  };
}
