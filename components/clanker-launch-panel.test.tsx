// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, Activity, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { decodeFunctionData, parseEther } from 'viem';
import { Clanker } from 'clanker-sdk/v4';
import { ClankerLaunchPanel } from './clanker-launch-panel';
import { connectEvmWallet } from '@/lib/evm-wallet';

const admin = '0x1111111111111111111111111111111111111111';
vi.mock('@/lib/evm-wallet', () => ({
  connectEvmWallet: vi.fn(async () => admin),
  walletError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

let host: HTMLDivElement, root: Root;
const sent: { to: string; data: `0x${string}`; value: string }[] = [];
const rpcMethods: string[] = [];

beforeEach(() => {
  vi.mocked(connectEvmWallet).mockReset().mockResolvedValue(admin);
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

it.each(['eth_call', 'eth_estimateGas'])(
  'does not restore an old review after inputs change during %s',
  async (method) => {
    let release!: () => void,
      waiting = false;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: Parameters<typeof fetch>) => {
        const body = JSON.parse((args[1] as RequestInit).body as string);
        if (body.method === method) {
          waiting = true;
          await barrier;
        }
        return original(...args);
      }),
    );
    await act(async () =>
      root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
    );
    await act(async () => button('Simulate launch').click());
    await vi.waitFor(() => expect(waiting).toBe(true));
    await act(async () => type('Token symbol', 'NEW'));
    await act(async () => release());
    await vi.waitFor(() =>
      expect(button('Simulate launch').disabled).toBe(false),
    );
    expect(button('Send with my wallet')).toBeUndefined();
    expect(sent).toHaveLength(0);
    await act(async () => button('Simulate launch').click());
    expect(host.textContent).toContain('Deploys NEW');
    expect(button('Send with my wallet').disabled).toBe(true);
  },
);

it('invalidates an approved review before a new simulation, including when it fails', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => button('Simulate launch').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(button('Send with my wallet').disabled).toBe(false);
  vi.mocked(connectEvmWallet).mockRejectedValueOnce(
    new Error('Connection rejected'),
  );
  await act(async () => button('Simulate launch').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Connection rejected',
  );
  expect(button('Send with my wallet')).toBeUndefined();
  expect(sent).toHaveLength(0);
});

it('refuses a pending send after the parent launch context changes', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => button('Simulate launch').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  let release!: (value: typeof admin) => void;
  vi.mocked(connectEvmWallet).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => button('Send with my wallet').click());
  const isCurrent = vi.mocked(connectEvmWallet).mock.calls.at(-1)![2]!;
  expect(isCurrent()).toBe(true);
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Other" symbol="NEW" />),
  );
  expect(isCurrent()).toBe(false);
  await act(async () => release(admin));
  expect(sent).toHaveLength(0);
  expect(button('Send with my wallet')).toBeUndefined();
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Token symbol"]')
      ?.value,
  ).toBe('NEW');
});

it('does not carry a prepared review to a replacement wallet provider', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => button('Simulate launch').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  const request = vi.fn();
  (globalThis as { ethereum?: unknown }).ethereum = { request };
  await act(async () => button('Send with my wallet').click());
  expect(request).not.toHaveBeenCalled();
  expect(button('Send with my wallet')).toBeUndefined();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Wallet provider changed',
  );
  expect(sent).toHaveLength(0);
});

it('retains the account-change refusal before handing anything to the wallet', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => button('Simulate launch').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  vi.mocked(connectEvmWallet).mockResolvedValueOnce(
    '0x2222222222222222222222222222222222222222',
  );
  await act(async () => button('Send with my wallet').click());
  expect(sent).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Wallet account changed',
  );
  expect(button('Send with my wallet')).toBeUndefined();
});

it('allows only one wallet handoff for an acknowledgement, including a rejected request', async () => {
  await act(async () =>
    root.render(<ClankerLaunchPanel name="Test" symbol="TST" />),
  );
  await act(async () => button('Simulate launch').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  const p = (
    globalThis as {
      ethereum?: { request: (args: unknown) => Promise<unknown> };
    }
  ).ethereum!;
  let reject!: (error: Error) => void;
  const request = vi.fn(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  p.request = request;
  const send = button('Send with my wallet');
  await act(async () => {
    send.click();
    send.click();
  });
  expect(request).toHaveBeenCalledOnce();
  expect(
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
  ).toBe(false);
  await act(async () => reject(new Error('Request declined')));
  expect(send.disabled).toBe(true);
  await act(async () => send.click());
  expect(request).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Request declined',
  );
});

it('survives Strict Mode cleanup with explicit simulation and fresh unchecked consent', async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <ClankerLaunchPanel name="Test" symbol="TST" />
      </StrictMode>,
    ),
  );
  expect(rpcMethods).toEqual([]);
  await act(async () => button('Simulate launch').click());
  expect(rpcMethods).toEqual(['eth_call', 'eth_estimateGas']);
  expect(host.textContent).toContain('Deploys TST');
  expect(button('Send with my wallet').disabled).toBe(true);
  expect(sent).toHaveLength(0);
});

it('clears a checked review when a hidden panel is restored', async () => {
  const render = (mode: 'visible' | 'hidden') =>
    act(async () =>
      root.render(
        <Activity mode={mode}>
          <ClankerLaunchPanel name="Test" symbol="TST" />
        </Activity>,
      ),
    );
  await render('visible');
  await act(async () => button('Simulate launch').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(button('Send with my wallet').disabled).toBe(false);
  await render('hidden');
  await render('visible');
  expect(button('Send with my wallet')).toBeUndefined();
  expect(sent).toHaveLength(0);
  await act(async () => button('Simulate launch').click());
  expect(button('Send with my wallet').disabled).toBe(true);
});
