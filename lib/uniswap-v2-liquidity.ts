import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

// Uniswap V2 LP review for a launch's TOKEN/WETH pair. Reads are public;
// every transaction is sent through the user's own browser wallet, which
// asks them to confirm it.

export const UNISWAP_V2 = {
  Ethereum: {
    factory: getAddress('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'),
    router: getAddress('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'),
    weth: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  },
} as const;
export type UniswapV2Chain = keyof typeof UNISWAP_V2;
export const BURN_ADDRESS = getAddress(
  '0x000000000000000000000000000000000000dEaD',
);

export const factoryAbi = parseAbi([
  'function getPair(address,address) view returns (address)',
]);
export const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);
export const routerAbi = parseAbi([
  'function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)',
  'function removeLiquidityETH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) returns (uint256,uint256)',
]);

export type LpPosition = {
  pair: Address;
  lpBalance: bigint;
  totalSupply: bigint;
  tokenReserve: bigint;
  wethReserve: bigint;
  // Basis points of the pool owned by this wallet.
  shareBasisPoints: number;
  redeemableToken: bigint;
  redeemableEth: bigint;
};

export function lpPosition(input: {
  pair: Address;
  token: Address;
  token0: Address;
  reserves: readonly [bigint, bigint];
  totalSupply: bigint;
  lpBalance: bigint;
}): LpPosition {
  const tokenIsZero = getAddress(input.token0) === getAddress(input.token);
  const [tokenReserve, wethReserve] = tokenIsZero
    ? input.reserves
    : [input.reserves[1], input.reserves[0]];
  const { totalSupply, lpBalance } = input;
  if (lpBalance > totalSupply) throw new Error('LP balance exceeds supply.');
  const of = (reserve: bigint) =>
    totalSupply > 0n ? (reserve * lpBalance) / totalSupply : 0n;
  return {
    pair: input.pair,
    lpBalance,
    totalSupply,
    tokenReserve,
    wethReserve,
    shareBasisPoints:
      totalSupply > 0n ? Number((lpBalance * 10000n) / totalSupply) : 0,
    redeemableToken: of(tokenReserve),
    redeemableEth: of(wethReserve),
  };
}

/** Floor an amount by a slippage tolerance in basis points. */
export function withSlippage(amount: bigint, slippageBasisPoints: number) {
  if (
    !Number.isInteger(slippageBasisPoints) ||
    slippageBasisPoints < 0 ||
    slippageBasisPoints > 5000
  )
    throw new Error('Slippage must be 0-50%.');
  return (amount * BigInt(10000 - slippageBasisPoints)) / 10000n;
}

export function approveRouterCall(chain: UniswapV2Chain, amount: bigint): Hex {
  return encodeFunctionData({
    abi: pairAbi,
    functionName: 'approve',
    args: [UNISWAP_V2[chain].router, amount],
  });
}

export function removeLiquidityCall(input: {
  token: Address;
  position: LpPosition;
  slippageBasisPoints: number;
  to: Address;
  deadlineSeconds: number;
}): Hex {
  if (input.position.lpBalance === 0n) throw new Error('No LP tokens held.');
  return encodeFunctionData({
    abi: routerAbi,
    functionName: 'removeLiquidityETH',
    args: [
      getAddress(input.token),
      input.position.lpBalance,
      withSlippage(input.position.redeemableToken, input.slippageBasisPoints),
      withSlippage(input.position.redeemableEth, input.slippageBasisPoints),
      getAddress(input.to),
      BigInt(input.deadlineSeconds),
    ],
  });
}

export const erc20Abi = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export function approveTokenCall(chain: UniswapV2Chain, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [UNISWAP_V2[chain].router, amount],
  });
}

/**
 * Seeds a new TOKEN/WETH pair. Only for a pair with no liquidity yet, so the
 * amounts are taken exactly: the minimums equal the amounts sent.
 */
export function createPoolCall(input: {
  token: Address;
  tokenAmount: bigint;
  ethAmount: bigint;
  to: Address;
  deadlineSeconds: number;
}): Hex {
  if (input.tokenAmount <= 0n || input.ethAmount <= 0n)
    throw new Error('Enter token and ETH amounts above zero.');
  return encodeFunctionData({
    abi: routerAbi,
    functionName: 'addLiquidityETH',
    args: [
      getAddress(input.token),
      input.tokenAmount,
      input.tokenAmount,
      input.ethAmount,
      getAddress(input.to),
      BigInt(input.deadlineSeconds),
    ],
  });
}

export function burnLpCall(position: LpPosition): Hex {
  if (position.lpBalance === 0n) throw new Error('No LP tokens held.');
  return encodeFunctionData({
    abi: pairAbi,
    functionName: 'transfer',
    args: [BURN_ADDRESS, position.lpBalance],
  });
}
