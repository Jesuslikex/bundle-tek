'use client';
import { useState } from 'react';
import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  maxUint256,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { EVM_NETWORKS } from '@/lib/evm-network';
import { connectEvmWallet, walletError } from '@/lib/evm-wallet';
import {
  UNISWAP_V2,
  approveRouterCall,
  approveTokenCall,
  createPoolCall,
  erc20Abi,
  burnLpCall,
  factoryAbi,
  lpPosition,
  pairAbi,
  removeLiquidityCall,
  routerAbi,
  type LpPosition,
  type UniswapV2Chain,
} from '@/lib/uniswap-v2-liquidity';

type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
const ZERO = '0x0000000000000000000000000000000000000000';
const clients = new Map<
  UniswapV2Chain,
  ReturnType<typeof createPublicClient>
>();
const clientFor = (chain: UniswapV2Chain) => {
  let c = clients.get(chain);
  if (!c) {
    c = createPublicClient({ transport: http(EVM_NETWORKS[chain].endpoint) });
    clients.set(chain, c);
  }
  return c;
};
const pct = (bps: number) => (bps / 100).toFixed(2) + '%';

export function LiquidityPoolPanel({
  chain = 'Ethereum',
  tokenDecimals = 18,
}: {
  chain?: UniswapV2Chain;
  tokenDecimals?: number;
}) {
  const CHAIN = chain;
  const client = clientFor(chain);
  const [token, setToken] = useState('');
  const [account, setAccount] = useState<Address | null>(null);
  const [position, setPosition] = useState<LpPosition | null>(null);
  const [noPair, setNoPair] = useState(false);
  const [action, setAction] = useState<'remove' | 'burn'>('remove');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [seedToken, setSeedToken] = useState('');
  const [seedEth, setSeedEth] = useState('');
  const [seedAck, setSeedAck] = useState(false);
  const provider = () =>
    (globalThis as { ethereum?: Provider }).ethereum ?? null;

  async function guarded(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await task();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    const wallet = provider();
    if (!wallet) throw new Error('No browser wallet found. Install one first.');
    if (!isAddress(token)) throw new Error('Enter the token contract address.');
    const address = getAddress(
      await connectEvmWallet(wallet as never, CHAIN),
    ) as Address;
    setAccount(address);
    setAck(false);
    const tokenAddress = getAddress(token);
    const { factory, weth, router } = UNISWAP_V2[CHAIN];
    // Confirm the pinned router really points at the pinned factory and WETH
    // before anything is read or sent.
    const [routerFactory, routerWeth] = await Promise.all([
      client.readContract({
        address: router,
        abi: routerAbi,
        functionName: 'factory',
      }),
      client.readContract({
        address: router,
        abi: routerAbi,
        functionName: 'WETH',
      }),
    ]);
    if (
      getAddress(routerFactory) !== factory ||
      getAddress(routerWeth) !== weth
    )
      throw new Error(
        'The Uniswap router on this chain does not match the pinned contracts. Nothing was sent.',
      );
    const pair = await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'getPair',
      args: [tokenAddress, weth],
    });
    if (pair === ZERO) {
      setPosition(null);
      setNoPair(true);
      return;
    }
    setNoPair(false);
    const [token0, reserves, totalSupply, lpBalance] = await Promise.all([
      client.readContract({
        address: pair,
        abi: pairAbi,
        functionName: 'token0',
      }),
      client.readContract({
        address: pair,
        abi: pairAbi,
        functionName: 'getReserves',
      }),
      client.readContract({
        address: pair,
        abi: pairAbi,
        functionName: 'totalSupply',
      }),
      client.readContract({
        address: pair,
        abi: pairAbi,
        functionName: 'balanceOf',
        args: [address],
      }),
    ]);
    setPosition(
      lpPosition({
        pair,
        token: tokenAddress,
        token0,
        reserves: [reserves[0], reserves[1]],
        totalSupply,
        lpBalance,
      }),
    );
  }
  // The browser wallet shows each transaction for the user to confirm.
  async function send(to: Address, data: Hex, value = 0n) {
    const hash = await provider()!.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: account,
          to,
          data,
          ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
        },
      ],
    });
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash))
      throw new Error('Wallet returned an unexpected transaction hash.');
    await client.waitForTransactionReceipt({ hash: hash as Hex });
    return hash;
  }
  async function createPool() {
    if (!account) return;
    const tokenAddress = getAddress(token);
    const tokenAmount = parseUnits(seedToken, tokenDecimals);
    const ethAmount = parseEther(seedEth);
    const data = createPoolCall({
      token: tokenAddress,
      tokenAmount,
      ethAmount,
      to: account,
      deadlineSeconds: Math.floor(Date.now() / 1000) + 600,
    });
    const { router } = UNISWAP_V2[CHAIN];
    const [balance, allowance] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      }),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, router],
      }),
    ]);
    if (balance < tokenAmount)
      throw new Error('This wallet holds fewer tokens than that.');
    if (allowance < tokenAmount) {
      setNote('Approve the token for the router in your wallet first…');
      await send(tokenAddress, approveTokenCall(CHAIN, tokenAmount));
    }
    const hash = await send(router, data, ethAmount);
    setNote(`Pool created in ${hash}.`);
    setSeedAck(false);
    await review();
  }
  async function confirm() {
    if (!position || !account) return;
    const { router } = UNISWAP_V2[CHAIN];
    if (action === 'burn') {
      const hash = await send(position.pair, burnLpCall(position));
      setNote(`LP burned in ${hash}.`);
    } else {
      const allowance = await client.readContract({
        address: position.pair,
        abi: pairAbi,
        functionName: 'allowance',
        args: [account, router],
      });
      if (allowance < position.lpBalance) {
        setNote('Approve the router in your wallet first…');
        await send(position.pair, approveRouterCall(CHAIN, maxUint256));
      }
      const hash = await send(
        router,
        removeLiquidityCall({
          token: getAddress(token),
          position,
          slippageBasisPoints: 100,
          to: account,
          deadlineSeconds: Math.floor(Date.now() / 1000) + 600,
        }),
      );
      setNote(`Liquidity removed in ${hash}.`);
    }
    await review();
  }

  return (
    <section aria-label="Liquidity pool" className="min-w-0 space-y-2">
      <h3>Liquidity pool · Uniswap V2 on {chain}</h3>
      <p className="text-xs text-muted-foreground">
        Reads your TOKEN/WETH pool position from the chain. Removing or burning
        liquidity is sent from your own browser wallet, which asks you to
        confirm every transaction.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Token contract address"
          placeholder="0x… token address"
          value={token}
          onChange={(e) => {
            setToken(e.target.value.trim());
            setPosition(null);
            setNoPair(false);
          }}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !token}
          onClick={() => void guarded(review)}
        >
          {position ? 'Refresh' : 'Review pool'}
        </Button>
      </div>
      {account && (noPair || position?.totalSupply === 0n) && (
        <fieldset className="space-y-2">
          <legend>Create the pool</legend>
          <p>
            No liquidity exists for this token and WETH yet. Seeding it sets the
            starting price at your ETH ÷ token ratio.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Token amount"
              placeholder="Token amount"
              inputMode="decimal"
              value={seedToken}
              onChange={(e) => {
                setSeedToken(e.target.value.trim());
                setSeedAck(false);
              }}
              className="w-44"
            />
            <Input
              aria-label="ETH amount"
              placeholder="ETH amount"
              inputMode="decimal"
              value={seedEth}
              onChange={(e) => {
                setSeedEth(e.target.value.trim());
                setSeedAck(false);
              }}
              className="w-44"
            />
          </div>
          <label className="block">
            <input
              type="checkbox"
              checked={seedAck}
              onChange={(e) => setSeedAck(e.target.checked)}
            />{' '}
            I confirm sending {seedToken || '0'} tokens and {seedEth || '0'} ETH
            into a new public pool, and that anyone can trade against it at
            once.
          </label>
          <Button
            type="button"
            disabled={busy || !seedAck || !seedToken || !seedEth}
            onClick={() => void guarded(createPool)}
          >
            Create pool
          </Button>
        </fieldset>
      )}
      {position && position.totalSupply > 0n && (
        <>
          <div className="dashboard-stats">
            <article>
              <span>Total liquidity</span>
              <strong>{formatEther(position.wethReserve)} ETH</strong>
              <small>
                {formatUnits(position.tokenReserve, tokenDecimals)} tokens
              </small>
            </article>
            <article>
              <span>Your LP share</span>
              <strong>{pct(position.shareBasisPoints)}</strong>
              <small>{formatEther(position.lpBalance)} LP</small>
            </article>
            <article>
              <span>Redeemable (estimate)</span>
              <strong>{formatEther(position.redeemableEth)} ETH</strong>
              <small>
                {formatUnits(position.redeemableToken, tokenDecimals)} tokens
              </small>
            </article>
          </div>
          {position.lpBalance === 0n ? (
            <p>This wallet holds no LP tokens for this pool.</p>
          ) : (
            <fieldset className="space-y-2">
              <legend>Action</legend>
              <label className="mr-4">
                <input
                  type="radio"
                  checked={action === 'remove'}
                  onChange={() => {
                    setAction('remove');
                    setAck(false);
                  }}
                />{' '}
                Remove liquidity (get ETH and tokens back, 1% slippage limit)
              </label>
              <label>
                <input
                  type="radio"
                  checked={action === 'burn'}
                  onChange={() => {
                    setAction('burn');
                    setAck(false);
                  }}
                />{' '}
                Burn LP (permanent, nothing comes back)
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{' '}
                {action === 'burn'
                  ? 'I understand burned LP can never be redeemed.'
                  : `I understand removing ${pct(position.shareBasisPoints)} of the pool raises slippage, and removing 95% or more makes the token effectively untradable.`}
              </label>
              <Button
                type="button"
                disabled={busy || !ack}
                onClick={() => void guarded(confirm)}
              >
                {action === 'burn' ? 'Burn all LP' : 'Remove all liquidity'}
              </Button>
            </fieldset>
          )}
        </>
      )}
      {note && <output>{note}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
