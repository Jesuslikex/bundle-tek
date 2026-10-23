// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiquidityPoolPanel } from './liquidity-pool-panel';
import { UNISWAP_V2 } from '@/lib/uniswap-v2-liquidity';
const mock = vi.hoisted(() => ({
  read: vi.fn(),
  wait: vi.fn(),
  receipt: vi.fn(),
  chain: vi.fn(),
}));
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({
    readContract: mock.read,
    waitForTransactionReceipt: mock.wait,
    getTransactionReceipt: mock.receipt,
    getChainId: mock.chain,
  }),
}));
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const PAIR = '0x4444444444444444444444444444444444444444';
const HASH = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';
let host: HTMLDivElement, root: Root;
let request: ReturnType<typeof vi.fn>;
let accounts: string[], network: string, noPair: boolean, allowance: bigint;
let events: Map<string, () => void>;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  accounts = [ACCOUNT];
  network = '0x1';
  noPair = false;
  allowance = 1000n;
  events = new Map();
  mock.chain.mockReset().mockResolvedValue(1);
  mock.read
    .mockReset()
    .mockImplementation(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'factory':
          return UNISWAP_V2.Ethereum.factory;
        case 'WETH':
          return UNISWAP_V2.Ethereum.weth;
        case 'getPair':
          return noPair ? ZERO : PAIR;
        case 'token0':
          return TOKEN;
        case 'getReserves':
          return [1000n, 1000n, 0];
        case 'totalSupply':
          return 1000n;
        case 'balanceOf':
          return 1000n;
        case 'allowance':
          return allowance;
        default:
          throw Error('Unexpected fixture read');
      }
    });
  mock.wait
    .mockReset()
    .mockResolvedValue({ transactionHash: HASH, status: 'success' });
  mock.receipt
    .mockReset()
    .mockResolvedValue({ transactionHash: HASH, status: 'success' });
  request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return network;
    if (method === 'eth_requestAccounts' || method === 'eth_accounts')
      return accounts;
    if (method === 'eth_sendTransaction') return HASH;
    throw Error('Unexpected fixture wallet request');
  });
  vi.stubGlobal('ethereum', {
    request,
    on: (event: string, fn: () => void) => events.set(event, fn),
    removeListener: (event: string) => events.delete(event),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const text = () => host.textContent ?? '';
const sendCount = () =>
  request.mock.calls.filter(([arg]) => arg.method === 'eth_sendTransaction')
    .length;
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label,
  );
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function input(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function checkLast() {
  const boxes = host.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  await act(async () => boxes[boxes.length - 1]!.click());
}
async function setup(burn = false) {
  await act(async () => root.render(<LiquidityPoolPanel tokenDecimals={0} />));
  await input('Token contract address', TOKEN);
  await click('Review pool');
  if (burn)
    await act(async () =>
      host
        .querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!
        .click(),
    );
  await checkLast();
}
it('asks for a token before any read or transaction', () => {
  const html = renderToStaticMarkup(<LiquidityPoolPanel />);
  expect(html).toContain('Review pool');
  expect(html).toContain('confirm every transaction');
  expect(html).not.toContain('Remove all liquidity');
  expect(mock.read).not.toHaveBeenCalled();
});
it.each(['remove', 'burn', 'create'] as const)(
  'refuses reverted %s receipts without success copy',
  async (kind) => {
    noPair = kind === 'create';
    await setup(kind === 'burn');
    if (kind === 'create') {
      await input('Token amount', '1');
      await input('ETH amount', '0.1');
      await checkLast();
    }
    mock.wait.mockResolvedValue({ transactionHash: HASH, status: 'reverted' });
    await click(
      kind === 'create'
        ? 'Create pool'
        : kind === 'burn'
          ? 'Burn all LP'
          : 'Remove all liquidity',
    );
    expect(sendCount()).toBe(1);
    expect(text()).toContain('Transaction reverted');
    expect(text()).not.toMatch(
      /Pool created in|LP burned in|Liquidity removed in/,
    );
    expect(text()).toContain(HASH);
  },
);
it.each([
  undefined,
  {},
  { transactionHash: HASH },
  { transactionHash: HASH, status: 'pending' },
  { transactionHash: '0x' + 'b'.repeat(64), status: 'success' },
])('retains unknown for malformed/replaced receipt %j', async (receipt) => {
  await setup(true);
  mock.wait.mockResolvedValue(receipt);
  await click('Burn all LP');
  expect(sendCount()).toBe(1);
  expect(text()).toContain('Outcome unknown');
  expect(text()).toContain(HASH);
  expect(text()).not.toContain('LP burned in');
  expect(text()).not.toContain('Burn all LP');
  expect(sendCount()).toBe(1);
});
it.each(['reverted', 'timeout', 'replacement'] as const)(
  'does not continue after %s approval',
  async (kind) => {
    allowance = 0n;
    await setup();
    if (kind === 'timeout')
      mock.wait.mockRejectedValue(Error('fixture timeout'));
    else
      mock.wait.mockResolvedValue({
        transactionHash: kind === 'replacement' ? '0x' + 'b'.repeat(64) : HASH,
        status: kind === 'reverted' ? 'reverted' : 'success',
      });
    await click('Remove all liquidity');
    expect(sendCount()).toBe(1);
    expect(text()).not.toContain('Liquidity removed in');
  },
);
it('rechecks account before the send after approval', async () => {
  allowance = 0n;
  await setup();
  mock.wait.mockImplementation(async () => {
    accounts = [OTHER];
    return { transactionHash: HASH, status: 'success' };
  });
  await click('Remove all liquidity');
  expect(sendCount()).toBe(1);
  expect(text()).toContain('Wallet account or provider network changed');
  expect(text()).not.toContain('Liquidity removed in');
});
it.each(['wallet', 'rpc'] as const)(
  'rejects wrong %s chain before sending',
  async (kind) => {
    await setup(true);
    if (kind === 'wallet') network = '0x1junk';
    else mock.chain.mockResolvedValue(4663);
    await click('Burn all LP');
    expect(sendCount()).toBe(0);
  },
);
it('accepts exact successful original receipt and retains its hash', async () => {
  await setup(true);
  mock.wait.mockResolvedValue({
    transactionHash: HASH.toUpperCase(),
    status: 'success',
  });
  await click('Burn all LP');
  expect(sendCount()).toBe(1);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'eth_sendTransaction',
      params: [expect.objectContaining({ from: ACCOUNT, chainId: '0x1' })],
    }),
  );
  expect(text()).toContain(`LP burned in ${HASH}`);
  expect(text()).toContain('Original transaction receipt reports success');
  const retainedHash = host.querySelector('code');
  expect(retainedHash?.textContent).toBe(HASH);
  expect(retainedHash?.classList.contains('break-all')).toBe(true);
});
it.each([false, true])(
  'recovery requires a new review and unchecked approval without automatically resuming (burn=%s)',
  async (burn) => {
    allowance = 0n;
    await setup(burn);
    const actionLabel = burn ? 'Burn all LP' : 'Remove all liquidity';
    mock.wait.mockRejectedValue(Error('timeout'));
    await click(actionLabel);
    expect(text()).toContain('Outcome unknown');
    expect(text()).not.toContain(actionLabel);
    const readsBefore = mock.read.mock.calls.length;
    await click('Check original receipt');
    expect(mock.receipt).toHaveBeenCalledWith({ hash: HASH });
    expect(mock.read.mock.calls.length).toBe(readsBefore);
    expect(sendCount()).toBe(1);
    expect(text()).not.toContain(actionLabel);
    expect(text()).not.toContain('Liquidity removed in');
    expect(text()).toContain('Original transaction receipt reports success');
    expect(text()).not.toContain('outcome is unknown');
    await click('Review pool');
    const approval = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(approval.checked).toBe(false);
    const remove = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === actionLabel,
    )!;
    expect(remove.disabled).toBe(true);
    expect(sendCount()).toBe(1);
  },
);
it('locks inputs and synchronous duplicate requests while pending', async () => {
  await setup(true);
  let resolve!: (value: unknown) => void;
  mock.wait.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await click('Burn all LP');
  expect(sendCount()).toBe(1);
  expect(
    host.querySelector<HTMLInputElement>(
      'input[aria-label="Token contract address"]',
    )!.disabled,
  ).toBe(true);
  await click('Burn all LP');
  expect(sendCount()).toBe(1);
  await act(async () => resolve({ transactionHash: HASH, status: 'success' }));
});
it('invalidates a delayed review when wallet context changes', async () => {
  await act(async () => root.render(<LiquidityPoolPanel />));
  await input('Token contract address', TOKEN);
  let resolve!: (value: unknown) => void;
  mock.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await click('Review pool');
  await act(async () => events.get('accountsChanged')!());
  await act(async () => resolve(UNISWAP_V2.Ethereum.factory));
  expect(text()).not.toContain('Remove all liquidity');
  expect(sendCount()).toBe(0);
});
it('preserves original chain/hash after chain prop changes during a send', async () => {
  await setup(true);
  let resolve!: (value: unknown) => void;
  request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return network;
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_sendTransaction')
      return new Promise((r) => {
        resolve = r;
      });
    throw Error('Unexpected request');
  });
  await click('Burn all LP');
  await act(async () =>
    root.render(<LiquidityPoolPanel chain="Robinhood" tokenDecimals={0} />),
  );
  await act(async () => resolve(HASH));
  expect(text()).toContain('Burn LP · Ethereum');
  expect(text()).toContain(HASH);
  expect(text()).toContain('Outcome unknown');
  expect(mock.wait).not.toHaveBeenCalled();
  expect(sendCount()).toBe(1);
});

it.each(['reverted', 'timeout'] as const)(
  'stops create after %s token approval',
  async (kind) => {
    noPair = true;
    allowance = 0n;
    await setup();
    await input('Token amount', '1');
    await input('ETH amount', '0.1');
    await checkLast();
    if (kind === 'timeout')
      mock.wait.mockRejectedValue(Error('fixture timeout'));
    else
      mock.wait.mockResolvedValue({
        transactionHash: HASH,
        status: 'reverted',
      });
    await click('Create pool');
    expect(sendCount()).toBe(1);
    expect(text()).not.toContain('Pool created in');
  },
);
it.each(['error', 'invalid hash'] as const)(
  'retains an ambiguous wallet %s without retry',
  async (kind) => {
    await setup(true);
    request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return network;
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_sendTransaction') {
        if (kind === 'error') throw Error('provider disconnected');
        return 'not a hash';
      }
      throw Error('Unexpected request');
    });
    await click('Burn all LP');
    expect(sendCount()).toBe(1);
    expect(text()).toContain('Outcome unknown');
    expect(text()).toContain('No valid transaction hash');
    expect(text()).not.toContain('Burn all LP');
    expect(sendCount()).toBe(1);
  },
);
it('shows an explicit wallet decline separately from reverted or unknown', async () => {
  await setup(true);
  request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return network;
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_sendTransaction') throw { code: 4001 };
    throw Error('Unexpected request');
  });
  await click('Burn all LP');
  expect(sendCount()).toBe(1);
  expect(text()).toContain(
    'Wallet request declined; no transaction was submitted',
  );
  expect(text()).not.toContain('Transaction reverted');
  expect(text()).not.toContain('Outcome unknown');
});
it('does not release an unknown hold for a replacement recovery receipt', async () => {
  await setup(true);
  mock.wait.mockRejectedValue(Error('timeout'));
  await click('Burn all LP');
  mock.receipt.mockResolvedValue({
    transactionHash: '0x' + 'b'.repeat(64),
    status: 'success',
  });
  await click('Check original receipt');
  expect(text()).toContain('Outcome unknown');
  expect(sendCount()).toBe(1);
  expect(text()).not.toContain('Original transaction receipt reports success');
});
it('keeps original success when the subsequent pool refresh fails', async () => {
  await setup(true);
  mock.wait.mockImplementation(async () => {
    mock.read.mockRejectedValue(Error('refresh unavailable'));
    return { transactionHash: HASH, status: 'success' };
  });
  await click('Burn all LP');
  expect(sendCount()).toBe(1);
  expect(text()).toContain('Original transaction receipt reports success');
  expect(text()).toContain(HASH);
  expect(text()).not.toContain('Outcome unknown');
  expect(text()).toContain('refresh unavailable');
});
it('clears pool review and consent when token changes', async () => {
  await setup(true);
  await input('Token contract address', OTHER);
  expect(text()).not.toContain('Burn all LP');
  expect(text()).not.toContain('Create pool');
  expect(sendCount()).toBe(0);
});
it('holds the shared operation lock through a keyed chain remount', async () => {
  await setup(true);
  let resolve!: (value: unknown) => void;
  mock.wait.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await click('Burn all LP');
  await act(async () =>
    root.render(<LiquidityPoolPanel chain="Robinhood" tokenDecimals={0} />),
  );
  expect(
    host.querySelector<HTMLInputElement>(
      'input[aria-label="Token contract address"]',
    )!.disabled,
  ).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  await act(async () => resolve({ transactionHash: HASH, status: 'success' }));
  expect(sendCount()).toBe(1);
  expect(text()).toContain('Burn LP · Ethereum');
  expect(text()).not.toContain('LP burned in');
});

it('blocks duplicate clicks synchronously before React can render busy', async () => {
  await setup(true);
  let resolve!: (value: unknown) => void;
  mock.wait.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === 'Burn all LP',
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(sendCount()).toBe(1);
  await act(async () => resolve({ transactionHash: HASH, status: 'success' }));
});
it('refuses recovery on a different RPC network without a wallet request', async () => {
  await setup(true);
  mock.wait.mockRejectedValue(Error('timeout'));
  await click('Burn all LP');
  mock.chain.mockResolvedValue(4663);
  await click('Check original receipt');
  expect(mock.receipt).not.toHaveBeenCalled();
  expect(sendCount()).toBe(1);
  expect(text()).toContain('Outcome unknown');
});
