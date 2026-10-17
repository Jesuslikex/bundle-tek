import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress } from 'viem';
import {
  BURN_ADDRESS,
  UNISWAP_V2,
  burnLpCall,
  createPoolCall,
  lpPosition,
  pairAbi,
  removeLiquidityCall,
  routerAbi,
  withSlippage,
} from './uniswap-v2-liquidity';

const token = getAddress('0x1111111111111111111111111111111111111111');
const pair = getAddress('0x2222222222222222222222222222222222222222');
const weth = UNISWAP_V2.Ethereum.weth;

describe('lpPosition', () => {
  it('maps reserves by token order and computes share and redeemable', () => {
    const p = lpPosition({
      pair,
      token,
      token0: token,
      reserves: [1_000_000n, 10n ** 18n],
      totalSupply: 1000n,
      lpBalance: 250n,
    });
    expect(p.shareBasisPoints).toBe(2500);
    expect(p.redeemableToken).toBe(250_000n);
    expect(p.redeemableEth).toBe(25n * 10n ** 16n);
    const flipped = lpPosition({
      pair,
      token,
      token0: weth,
      reserves: [10n ** 18n, 1_000_000n],
      totalSupply: 1000n,
      lpBalance: 250n,
    });
    expect(flipped.redeemableToken).toBe(250_000n);
  });
  it('rejects a balance above supply', () => {
    expect(() =>
      lpPosition({
        pair,
        token,
        token0: token,
        reserves: [1n, 1n],
        totalSupply: 1n,
        lpBalance: 2n,
      }),
    ).toThrow();
  });
});

it('builds removeLiquidityETH with slippage floors and burn to dead', () => {
  const position = lpPosition({
    pair,
    token,
    token0: token,
    reserves: [1000n, 2000n],
    totalSupply: 100n,
    lpBalance: 100n,
  });
  const decoded = decodeFunctionData({
    abi: routerAbi,
    data: removeLiquidityCall({
      token,
      position,
      slippageBasisPoints: 100,
      to: token,
      deadlineSeconds: 123,
    }),
  });
  expect(decoded.args).toEqual([token, 100n, 990n, 1980n, token, 123n]);
  const burn = decodeFunctionData({ abi: pairAbi, data: burnLpCall(position) });
  expect(burn.args).toEqual([BURN_ADDRESS, 100n]);
  expect(withSlippage(1000n, 0)).toBe(1000n);
  expect(() => withSlippage(1n, 6000)).toThrow();
  expect(() => burnLpCall({ ...position, lpBalance: 0n })).toThrow();
});

it('seeds a new pool with exact minimums and rejects zero amounts', () => {
  const data = createPoolCall({
    token,
    tokenAmount: 5n,
    ethAmount: 7n,
    to: token,
    deadlineSeconds: 9,
  });
  const decoded = decodeFunctionData({ abi: routerAbi, data });
  expect(decoded.functionName).toBe('addLiquidityETH');
  expect(decoded.args).toEqual([token, 5n, 5n, 7n, token, 9n]);
  expect(() =>
    createPoolCall({
      token,
      tokenAmount: 0n,
      ethAmount: 1n,
      to: token,
      deadlineSeconds: 1,
    }),
  ).toThrow();
});
