import { validateFunding } from './funding-plan';
import { evmChain, EVM_NETWORKS } from './evm-network';
import { chainQuoteAssets } from './quote-catalog';
import { walletAddress } from './wallet-workspace';
import { balanceRpc } from './wallet-balances';
import { formatNativeBalance } from './wallet-balance-format';

const hex = (value: bigint) => '0x' + value.toString(16);
function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    throw new Error('Invalid fee provider quantity.');
  return BigInt(value);
}
function word(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Incomplete token balance or decimals.');
  return BigInt(value);
}
function atoms(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0'))
  );
}
export function fundingTransfers(value: unknown) {
  const document = validateFunding(value),
    chain = evmChain(document.chain),
    network = EVM_NETWORKS[chain];
  if (document.source !== 'Wallet' || !document.funderAddress)
    throw new Error(
      'Choose a wallet source and funder address for fee review.',
    );
  const funder = walletAddress(document.funderAddress, chain);
  const asset = document.assetAddress
    ? chainQuoteAssets(chain).find(
        (item) =>
          item.address.toLowerCase() === document.assetAddress!.toLowerCase(),
      )
    : undefined;
  const native = asset
    ? /^0x0{40}$/i.test(asset.address)
    : document.currency === network.currency;
  if (!asset && !native)
    throw new Error(
      'Choose the exact token contract before reviewing token fees.',
    );
  const decimals = native ? 18 : asset!.decimals;
  if (native && asset && asset.decimals !== 18)
    throw new Error('Unsupported native asset precision.');
  const contract = native ? null : walletAddress(asset!.address, chain);
  const transfers = document.recipients.map((item) => {
    const recipient = walletAddress(item.address, chain),
      raw = atoms(item.amount, decimals);
    if (recipient === funder)
      throw new Error('Funder cannot also be a recipient in this fee review.');
    if (raw >= 1n << 256n) throw new Error('Transfer amount exceeds uint256.');
    return {
      recipient,
      amount: item.amount,
      raw: raw.toString(),
      transaction: {
        from: funder,
        to: contract ?? recipient,
        value: native ? hex(raw) : '0x0',
        data: native
          ? '0x'
          : '0xa9059cbb' +
            recipient.slice(2).toLowerCase().padStart(64, '0') +
            raw.toString(16).padStart(64, '0'),
      },
    };
  });
  return {
    document,
    chain,
    network,
    funder,
    decimals,
    contract,
    transfers,
    totalRaw: atoms(document.total, decimals),
  };
}
export type FundingFeeReview = {
  chain: string;
  currency: string;
  nativeCurrency: string;
  funder: string;
  contract: string | null;
  transferTotal: string;
  transferBalance: string;
  nativeBalance: string;
  gasPriceRaw: string;
  estimatedFee: string | null;
  nativeRequired: string | null;
  nativeShortfall: string | null;
  transferShortfall: string;
  transfers: {
    recipient: string;
    amount: string;
    gas: string | null;
    estimatedFee: string | null;
  }[];
  blockNumber: number;
  blockHash: string;
  source: string;
  observedAt: string;
};
export async function reviewFundingFees(
  value: unknown,
  signal: AbortSignal = AbortSignal.timeout(25000),
  fetcher: typeof fetch = fetch,
): Promise<FundingFeeReview> {
  const plan = fundingTransfers(value),
    { network, contract, funder, transfers, totalRaw, decimals } = plan;
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(network.endpoint, method, params, signal, fetcher);
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(network.id))
    throw new Error('Fee provider network mismatch.');
  const header = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
    number?: unknown;
    hash?: unknown;
    timestamp?: unknown;
  };
  const number = quantity(header?.number),
    time = quantity(header?.timestamp) * 1000n;
  if (
    number > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof header.hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(header.hash) ||
    time < BigInt(Date.now() - 900000) ||
    time > BigInt(Date.now() + 300000)
  )
    throw new Error('Invalid or stale fee observation block.');
  const blockHash = header.hash,
    reference = { blockHash, requireCanonical: true };
  const nativeBalance = quantity(
    await rpc('eth_getBalance', [funder, reference]),
  );
  const gasPrice = quantity(await rpc('eth_gasPrice', []));
  if (gasPrice === 0n) throw new Error('Fee provider returned zero gas price.');
  let transferBalance = nativeBalance;
  if (contract) {
    const actualDecimals = word(
      await rpc('eth_call', [
        { to: contract, data: '0x313ce567', gas: '0x186a0' },
        reference,
      ]),
    );
    if (actualDecimals !== BigInt(decimals))
      throw new Error('Token decimals differ from the funding draft catalog.');
    transferBalance = word(
      await rpc('eth_call', [
        {
          to: contract,
          data: '0x70a08231' + funder.slice(2).toLowerCase().padStart(64, '0'),
          gas: '0x186a0',
        },
        reference,
      ]),
    );
  }
  const shortfall =
    totalRaw > transferBalance ? totalRaw - transferBalance : 0n;
  const estimates: (bigint | null)[] = Array(transfers.length).fill(null);
  // No pretend gas estimate if the selected transfer units are unavailable.
  if (shortfall === 0n) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, transfers.length) }, async () => {
        while (next < transfers.length) {
          const index = next++;
          const gas = quantity(
            await rpc('eth_estimateGas', [
              { ...transfers[index].transaction, gas: '0x989680' },
              hex(number),
            ]),
          );
          if (gas === 0n || gas > 10000000n)
            throw new Error('Invalid transfer gas estimate.');
          estimates[index] = gas;
        }
      }),
    );
  }
  const canonical = (await rpc('eth_getBlockByNumber', [
    hex(number),
    false,
  ])) as { hash?: unknown };
  if (canonical?.hash !== blockHash)
    throw new Error('Fee observation block changed. Refresh again.');
  const fee =
    shortfall === 0n
      ? estimates.reduce<bigint>((sum, gas) => sum + gas! * gasPrice, 0n)
      : null;
  const required = fee === null ? null : fee + (contract ? 0n : totalRaw);
  return {
    chain: plan.chain,
    currency: plan.document.currency,
    nativeCurrency: network.currency,
    funder,
    contract,
    transferTotal: plan.document.total,
    transferBalance: formatNativeBalance(transferBalance.toString(), decimals),
    nativeBalance: formatNativeBalance(nativeBalance.toString(), 18),
    gasPriceRaw: gasPrice.toString(),
    estimatedFee: fee === null ? null : formatNativeBalance(fee.toString(), 18),
    nativeRequired:
      required === null ? null : formatNativeBalance(required.toString(), 18),
    nativeShortfall:
      required === null
        ? null
        : formatNativeBalance(
            (required > nativeBalance
              ? required - nativeBalance
              : 0n
            ).toString(),
            18,
          ),
    transferShortfall: formatNativeBalance(shortfall.toString(), decimals),
    transfers: transfers.map((item, index) => ({
      recipient: item.recipient,
      amount: item.amount,
      gas: estimates[index]?.toString() ?? null,
      estimatedFee:
        estimates[index] === null
          ? null
          : formatNativeBalance((estimates[index]! * gasPrice).toString(), 18),
    })),
    blockNumber: Number(number),
    blockHash,
    source: new URL(network.endpoint).hostname,
    observedAt: new Date().toISOString(),
  };
}
