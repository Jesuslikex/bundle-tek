// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { decodeFunctionData, parseEther } from 'viem';
import { Clanker } from 'clanker-sdk/v4';
import { ClankerLaunchPanel } from './clanker-launch-panel';

const admin = '0x1111111111111111111111111111111111111111';
vi.mock('@/lib/evm-wallet', () => ({
  connectEvmWallet: vi.fn(async () => admin),
  walletError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

let host: HTMLDivElement, root: Root;
const sent: { to: string; data: `0x${string}`; value: string }[] = [];
const rpcMethods: string[] = [];

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  sent.length = 0;
  rpcMethods.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number; method: string };
      rpcMethods.push(body.method);
      const result = body.method === 'eth_estimateGas' ? '0x5208' : '0x';
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }),
  );
  (globalThis as { ethereum?: unknown }).ethereum = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params?: never[];
    }) => {
      if (method === 'eth_sendTransaction') {
        sent.push(params![0]);
        return '0x' + 'ab'.repeat(32);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (globalThis as { ethereum?: unknown }).ethereum;
});

function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

it('reviews a Bankr launch with dev buy and vault, then sends exactly that call', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  expect(button('Send with my wallet')).toBeUndefined();
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[value="Bankr"]')!.click(),
  );
  expect(host.textContent).toContain('Launch on Bankr (Base)');
  await act(async () => {
    type('Dev buy ETH', '0.02');
    type('Vault percent of supply', '15');
  });
  type('Vault lockup days', '14');
  await act(async () => button('Simulate launch').click());
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Trading fees: 80% to you'),
  );
  expect(rpcMethods).toEqual(['eth_call', 'eth_estimateGas']);
  expect(host.textContent).toContain('with 0.02 ETH (dev buy to your wallet)');
  expect(host.textContent).toContain('Vault: 15% of supply locked for 14 days');
  expect(host.textContent).toContain('20% to Bankr');
  expect(button('Send with my wallet').disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => button('Send with my wallet').click());
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].value).toBe('0x' + parseEther('0.02').toString(16));
  const { abi } = await new Clanker({}).getDeployTransaction({
    name: 'x',
    symbol: 'X',
    tokenAdmin: admin,
    chainId: 8453,
  });
  const args = decodeFunctionData({ abi, data: sent[0].data })
    .args[0] as unknown as {
    lockerConfig: { rewardBps: number[] };
  };
  expect(args.lockerConfig.rewardBps).toEqual([8000, 2000]);
});

it('clears the review when the draft changes', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => button('Simulate launch').click());
  await vi.waitFor(() => expect(button('Send with my wallet')).toBeDefined());
  await act(async () => type('Dev buy ETH', '0.01'));
  expect(button('Send with my wallet')).toBeUndefined();
});

it('shows validation errors without asking the wallet to sign', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => type('Dev buy ETH', '9'));
  await act(async () => button('Simulate launch').click());
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'capped',
    ),
  );
  expect(sent).toHaveLength(0);
  expect(rpcMethods).toEqual([]);
});
