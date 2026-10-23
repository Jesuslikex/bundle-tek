'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { EVM_NETWORKS } from '@/lib/evm-network';
import {
  connectEvmWallet,
  providerAccounts,
  providerChain,
  walletError,
} from '@/lib/evm-wallet';
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
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
};
type Outcome = {
  id: string;
  chain: UniswapV2Chain;
  account: Address;
  token: string;
  purpose: string;
  hash: Hex | null;
  status: 'unknown' | 'success' | 'reverted' | 'declined';
};
function receiptStatus(value: unknown, hash: Hex): 'success' | 'reverted' {
  if (
    !value ||
    typeof value !== 'object' ||
    !('transactionHash' in value) ||
    typeof value.transactionHash !== 'string' ||
    value.transactionHash.toLowerCase() !== hash.toLowerCase() ||
    !('status' in value) ||
    (value.status !== 'success' && value.status !== 'reverted')
  )
    throw new Error(
      'The original transaction outcome is unknown. Check its saved hash before another operation.',
    );
  return value.status as 'success' | 'reverted';
}
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
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [checking, setChecking] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const recoveryPending = useRef(false);
  const sending = useRef(false);
  const unresolved = useRef(new Set<string>());
  const [sendPending, setSendPending] = useState(false);
  const acquireSend = useCallback(() => {
    if (
      sending.current ||
      recoveryPending.current ||
      unresolved.current.size > 0
    )
      return null;
    sending.current = true;
    setSendPending(true);
    return () => {
      sending.current = false;
      setSendPending(false);
    };
  }, []);
  const retain = useCallback((outcome: Outcome) => {
    if (outcome.status === 'unknown') unresolved.current.add(outcome.id);
    else unresolved.current.delete(outcome.id);
    setOutcomes((rows) => [
      ...rows.filter((row) => row.id !== outcome.id),
      outcome,
    ]);
  }, []);
  async function recover(row: Outcome) {
    if (recoveryPending.current || sending.current || !row.hash) return;
    recoveryPending.current = true;
    setChecking(true);
    setRecoveryError('');
    try {
      const client = clientFor(row.chain);
      if ((await client.getChainId()) !== EVM_NETWORKS[row.chain].id)
        throw new Error('Receipt provider network mismatch.');
      const receipt = await client.getTransactionReceipt({ hash: row.hash });
      if ((await client.getChainId()) !== EVM_NETWORKS[row.chain].id)
        throw new Error('Receipt provider network mismatch.');
      retain({ ...row, status: receiptStatus(receipt, row.hash) });
    } catch {
      setRecoveryError(
        'The original transaction outcome is still unknown. No transaction was retried.',
      );
    } finally {
      recoveryPending.current = false;
      setChecking(false);
    }
  }
  const blocked = outcomes.some((row) => row.status === 'unknown');
  return (
    <>
      <LiquidityPoolContext
        key={JSON.stringify([chain, tokenDecimals])}
        chain={chain}
        tokenDecimals={tokenDecimals}
        retain={retain}
        blocked={blocked || checking || sendPending}
        acquireSend={acquireSend}
      />
      {outcomes.length > 0 && (
        <section
          aria-label="Liquidity transaction history"
          className="min-w-0 break-words"
        >
          <p>
            These transaction references last for this mounted workspace only.
            Save the hash before leaving. Receipt status is not an independent
            check of token transfers or finality.
          </p>
          {outcomes.map((row) => (
            <article key={row.id}>
              <p>
                {row.purpose} · {row.chain} · {row.account} · token {row.token}
              </p>
              <p>
                {row.status === 'unknown'
                  ? 'Outcome unknown. New sends are blocked.'
                  : row.status === 'reverted'
                    ? 'Transaction reverted. Network fees may have been charged.'
                    : row.status === 'declined'
                      ? 'Wallet request declined; no transaction was submitted.'
                      : 'Original transaction receipt reports success. Review the pool again before another action.'}
              </p>
              {row.hash ? (
                <>
                  <code className="break-all">{row.hash}</code>
                  {row.status === 'unknown' && (
                    <Button
                      type="button"
                      disabled={checking || sendPending}
                      onClick={() => void recover(row)}
                    >
                      Check original receipt
                    </Button>
                  )}
                </>
              ) : row.status === 'unknown' ? (
                <p>
                  No valid transaction hash was returned. Check your wallet
                  transaction history; this panel cannot safely retry.
                </p>
              ) : null}
            </article>
          ))}
          {recoveryError && <p role="alert">{recoveryError}</p>}
        </section>
      )}
    </>
  );
}
function LiquidityPoolContext({
  chain,
  tokenDecimals,
  retain,
  blocked,
  acquireSend,
}: {
  chain: UniswapV2Chain;
  tokenDecimals: number;
  retain: (outcome: Outcome) => void;
  blocked: boolean;
  acquireSend: () => (() => void) | null;
}) {
  const CHAIN = chain;
  const client = clientFor(chain);
  const [token, setToken] = useState('');
  const [account, setAccount] = useState<Address | null>(null);
  const [position, setPosition] = useState<LpPosition | null>(null);
  const [noPair, setNoPair] = useState(false);
  const [precisionNotice, setPrecisionNotice] = useState('');
  const [action, setAction] = useState<'remove' | 'burn'>('remove');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [seedToken, setSeedToken] = useState('');
  const [seedEth, setSeedEth] = useState('');
  const [seedAck, setSeedAck] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(false);
  const reviewedProvider = useRef<Provider | null>(null);
  const provider = () =>
    (globalThis as { ethereum?: Provider }).ethereum ?? null;
  useEffect(() => {
    mounted.current = true;
    const wallet = provider();
    const invalidate = () => {
      epoch.current++;
      setAccount(null);
      setPosition(null);
      setNoPair(false);
      setAck(false);
      setSeedAck(false);
      setNote(
        'Wallet context changed. Review the pool again. An existing transaction can still settle.',
      );
    };
    wallet?.on?.('accountsChanged', invalidate);
    wallet?.on?.('chainChanged', invalidate);
    return () => {
      mounted.current = false;
      wallet?.removeListener?.('accountsChanged', invalidate);
      wallet?.removeListener?.('chainChanged', invalidate);
    };
  }, []);
  function current(run: number, wallet?: Provider) {
    return (
      mounted.current &&
      epoch.current === run &&
      (!wallet || provider() === wallet)
    );
  }
  function assertCurrent(run: number, wallet?: Provider) {
    if (!current(run, wallet))
      throw new Error(
        'Wallet or pool context changed. Review again; an existing transaction can still settle.',
      );
  }
  async function guarded(
    task: (run: number) => Promise<void>,
    sending = false,
  ) {
    if (pending.current || (sending && blocked)) return;
    const release = sending ? acquireSend() : null;
    if (sending && !release) return;
    pending.current = true;
    const run = epoch.current;
    setBusy(true);
    setError('');
    setNote('');
    try {
      await task(run);
    } catch (e) {
      if (current(run)) {
        if (sending) {
          // An uncertain or failed request never revives its original consent after recovery.
          setAccount(null);
          setPosition(null);
          setNoPair(false);
          setAck(false);
          setSeedAck(false);
          reviewedProvider.current = null;
        }
        setError(walletError(e));
      }
    } finally {
      pending.current = false;
      release?.();
      if (mounted.current) setBusy(false);
    }
  }
  async function review(run: number) {
    setAck(false);
    setSeedAck(false);
    setAccount(null);
    setPosition(null);
    setNoPair(false);
    const wallet = provider();
    if (!wallet) throw new Error('No browser wallet found. Install one first.');
    if (!isAddress(token)) throw new Error('Enter the token contract address.');
    const address = getAddress(
      await connectEvmWallet(wallet as never, CHAIN, () =>
        current(run, wallet),
      ),
    ) as Address;
    assertCurrent(run, wallet);
    reviewedProvider.current = wallet;
    setAccount(null);
    setPosition(null);
    setNoPair(false);
    setAck(false);
    setSeedAck(false);
    const tokenAddress = getAddress(token);
    const { factory, weth, router } = UNISWAP_V2[CHAIN];
    // Confirm the pinned router really points at the pinned factory and WETH
    // before anything is read or sent.
    const [routerFactory, routerWeth, precision] = await Promise.all([
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
      observeTokenDecimals(run, wallet),
    ]);
    assertCurrent(run, wallet);
    if ((await client.getChainId()) !== EVM_NETWORKS[CHAIN].id)
      throw new Error('Pool provider network mismatch.');
    assertCurrent(run, wallet);
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
    assertCurrent(run, wallet);
    if (pair === ZERO) {
      if (!precision.verified) throw new Error(precision.notice);
      setPrecisionNotice('');
      await checkWallet(run, wallet, address);
      setAccount(address);
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
    if (totalSupply === 0n && !precision.verified)
      throw new Error(precision.notice);
    await checkWallet(run, wallet, address);
    setPrecisionNotice(precision.notice);
    setAccount(address);
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
  async function observeTokenDecimals(run: number, wallet: Provider) {
    assertCurrent(run, wallet);
    let precision: unknown;
    let unavailable = false;
    try {
      precision = await client.readContract({
        address: getAddress(token),
        abi: erc20Abi,
        functionName: 'decimals',
      });
    } catch {
      unavailable = true;
    }
    // Optional metadata never excuses a changed wallet/token context.
    assertCurrent(run, wallet);
    if (unavailable)
      return {
        verified: false,
        notice:
          'Token decimals are unavailable. Creating a pool requires verified token precision.',
      };
    if (
      typeof precision !== 'number' ||
      !Number.isInteger(precision) ||
      precision < 0 ||
      precision > 255
    )
      return {
        verified: false,
        notice:
          'Token decimals are malformed. Creating a pool requires verified token precision.',
      };
    if (precision !== tokenDecimals)
      return {
        verified: false,
        notice: `Token decimals (${precision}) differ from this panel's configured precision (${tokenDecimals}). Creating a pool requires matching verified precision; amounts were not reinterpreted.`,
      };
    return { verified: true, notice: '' };
  }
  async function requireTokenDecimals(run: number, wallet: Provider) {
    const precision = await observeTokenDecimals(run, wallet);
    if (!precision.verified) throw new Error(precision.notice);
  }
  async function checkWallet(run: number, wallet: Provider, address: Address) {
    assertCurrent(run, wallet);
    const [network, accounts] = await Promise.all([
      wallet.request({ method: 'eth_chainId' }),
      wallet.request({ method: 'eth_accounts' }),
    ]);
    assertCurrent(run, wallet);
    providerChain(network, CHAIN);
    if (
      !providerAccounts(accounts, CHAIN).some((a) => getAddress(a) === address)
    )
      throw new Error('Wallet account changed. Review again.');
  }
  // Each request still requires the browser wallet's own explicit confirmation.
  async function send(
    run: number,
    purpose: string,
    to: Address,
    data: Hex,
    value = 0n,
    options: { requireTokenPrecision?: boolean } = {},
  ) {
    const wallet = reviewedProvider.current;
    if (!wallet || !account)
      throw new Error('Review the wallet and pool first.');
    assertCurrent(run, wallet);
    const [network, accounts, rpcChain] = await Promise.all([
      wallet.request({ method: 'eth_chainId' }),
      wallet.request({ method: 'eth_accounts' }),
      client.getChainId(),
      options.requireTokenPrecision
        ? requireTokenDecimals(run, wallet)
        : Promise.resolve(),
    ]);
    assertCurrent(run, wallet);
    providerChain(network, CHAIN);
    if (
      rpcChain !== EVM_NETWORKS[CHAIN].id ||
      !providerAccounts(accounts, CHAIN).some((a) => getAddress(a) === account)
    )
      throw new Error(
        'Wallet account or provider network changed. Review again.',
      );
    const original: Outcome = {
      id: crypto.randomUUID(),
      chain: CHAIN,
      account,
      token,
      purpose,
      hash: null,
      status: 'unknown',
    };
    // Retain unknown BEFORE issuing the request: a lost wallet reply cannot prove no send.
    retain(original);
    let rawHash: unknown;
    try {
      rawHash = await wallet.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: account,
            chainId: `0x${EVM_NETWORKS[CHAIN].id.toString(16)}`,
            to,
            data,
            ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
          },
        ],
      });
    } catch (cause) {
      // Only the wallet's explicit user rejection proves this request was declined.
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 4001
      )
        retain({ ...original, status: 'declined' });
      throw new Error(
        'Wallet request did not return a confirmed outcome. Check the retained transaction reference.',
      );
    }
    if (typeof rawHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(rawHash))
      throw new Error(
        'Wallet returned no valid transaction hash. The outcome is unknown; do not retry.',
      );
    const hash = rawHash as Hex;
    const submitted = { ...original, hash };
    retain(submitted);
    // Preserve the hash even when context changes while the wallet prompt is open.
    assertCurrent(run, wallet);
    let status: 'success' | 'reverted';
    try {
      const receipt = await client.waitForTransactionReceipt({ hash });
      if ((await client.getChainId()) !== EVM_NETWORKS[CHAIN].id)
        throw new Error('Receipt provider network mismatch.');
      status = receiptStatus(receipt, hash);
    } catch {
      throw new Error(
        'The original wait did not establish an outcome. Consult the retained transaction status. No follow-on transaction was requested.',
      );
    }
    retain({ ...submitted, status });
    if (status !== 'success')
      throw new Error(
        'Transaction reverted. Network fees may have been charged. No follow-on transaction was requested.',
      );
    assertCurrent(run, wallet);
    return hash;
  }
  async function createPool(run: number) {
    if (!account || !seedAck) return;
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
    assertCurrent(run, reviewedProvider.current ?? undefined);
    if (balance < tokenAmount)
      throw new Error('This wallet holds fewer tokens than that.');
    if (allowance < tokenAmount) {
      setNote('Approve the token for the router in your wallet first…');
      await send(
        run,
        'Token approval',
        tokenAddress,
        approveTokenCall(CHAIN, tokenAmount),
        0n,
        { requireTokenPrecision: true },
      );
    }
    const hash = await send(run, 'Create pool', router, data, ethAmount, {
      requireTokenPrecision: true,
    });
    setNote(`Pool created in ${hash}.`);
    setSeedAck(false);
    await review(run);
  }
  async function confirm(run: number) {
    if (!position || !account || !ack) return;
    const { router } = UNISWAP_V2[CHAIN];
    if (action === 'burn') {
      const hash = await send(
        run,
        'Burn LP',
        position.pair,
        burnLpCall(position),
      );
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
        await send(
          run,
          'LP approval',
          position.pair,
          approveRouterCall(CHAIN, position.lpBalance),
        );
      }
      const hash = await send(
        run,
        'Remove liquidity',
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
    await review(run);
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
          disabled={busy || blocked}
          onChange={(e) => {
            if (pending.current) return;
            epoch.current++;
            setAccount(null);
            setAck(false);
            setSeedAck(false);
            setError('');
            setNote('');
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
        <fieldset disabled={busy || blocked} className="space-y-2">
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
            disabled={busy || blocked || !seedAck || !seedToken || !seedEth}
            onClick={() => void guarded(createPool, true)}
          >
            Create pool
          </Button>
        </fieldset>
      )}
      {position && position.totalSupply > 0n && (
        <>
          {precisionNotice && (
            <p role="alert">
              {precisionNotice} Token estimates below are raw token units. LP
              exit amounts use the original raw on-chain balances.
            </p>
          )}
          <div className="dashboard-stats">
            <article>
              <span>Total liquidity</span>
              <strong>{formatEther(position.wethReserve)} ETH</strong>
              <small>
                {precisionNotice
                  ? position.tokenReserve.toString()
                  : formatUnits(position.tokenReserve, tokenDecimals)}{' '}
                {precisionNotice ? 'raw token units' : 'tokens'}
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
                {precisionNotice
                  ? position.redeemableToken.toString()
                  : formatUnits(position.redeemableToken, tokenDecimals)}{' '}
                {precisionNotice ? 'raw token units' : 'tokens'}
              </small>
            </article>
          </div>
          {position.lpBalance === 0n ? (
            <p>This wallet holds no LP tokens for this pool.</p>
          ) : (
            <fieldset disabled={busy || blocked} className="space-y-2">
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
                disabled={busy || blocked || !ack}
                onClick={() => void guarded(confirm, true)}
              >
                {action === 'burn' ? 'Burn all LP' : 'Remove all liquidity'}
              </Button>
            </fieldset>
          )}
        </>
      )}
      {blocked && (
        <output>
          Check the original transaction outcome before any new send. Refreshing
          the pool does not clear an unknown outcome.
        </output>
      )}
      {note && <output className="block break-all">{note}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
