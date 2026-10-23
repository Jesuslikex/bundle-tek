// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';

let host: HTMLDivElement, root: Root;
const project = {
  id: 'p1',
  revision: 1,
  document: {
    token: {
      chain: 'Solana',
      address: 'Mint111111111111111111111111111111111111111',
      decimals: 6,
      totalSupplyRaw: '1000000000000000',
    },
  },
} as unknown as ImportedTokenProject;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
const click = async (text: string) => {
  await act(async () => button(text).click());
};

it('switches between Counter, DCA and Limit Orders', async () => {
  await act(async () =>
    root.render(<AutoSell project={project} wallets={[]} locked={false} />),
  );
  await click('Auto Sell');
  expect(host.textContent).toContain('Replication Factor');
  await click('◷ DCA');
  expect(host.textContent).toContain('Interval');
  expect(host.textContent).toContain('Fixed Amount');
  expect(host.textContent).not.toContain('Replication Factor');
  expect(host.textContent).not.toContain('Whitelist');
  expect(host.querySelector('[aria-label="DCA strategy"]')).not.toBeNull();
  await click('Randomized');
  expect(host.textContent).toContain('Min Amount');
  expect(host.textContent).toContain('Max Amount');
  await click('⇡ Limit Orders');
  expect(host.querySelectorAll('[aria-label$="market cap"]')).toHaveLength(1);
  await click('+ Add Order');
  expect(host.querySelectorAll('[aria-label$="market cap"]')).toHaveLength(2);
  await click('Token amount');
  expect(host.textContent).toContain('Tokens');
  expect(button('Run 1 Strategy').disabled).toBe(true);
});
const testWallet = {
  address: '11111111111111111111111111111111',
  chain: 'Solana',
  revision: 1,
  archived: false,
  label: 'Read-only fixture wallet',
} as WorkspaceWallet;
async function field(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function hint() {
  return document.getElementById(
    button('Run 1 Strategy').getAttribute('aria-describedby')!,
  )!;
}
async function validCounter() {
  const label = [...host.querySelectorAll('label')].find((x) =>
    x.textContent?.includes('Replication Factor'),
  )!;
  await field(document.getElementById(label.htmlFor) as HTMLInputElement, '10');
}

it.each(['strategy supply', 'strategy tokens', 'session tokens'])(
  'explains an impossible %s maximum before any unlock or preparation',
  async (kind) => {
    await act(async () =>
      root.render(
        <AutoSell project={project} wallets={[testWallet]} locked={false} />,
      ),
    );
    await click('Auto Sell');
    await validCounter();
    const inputFor = (text: string) => {
      const label = [...host.querySelectorAll<HTMLLabelElement>('label')].find(
        (l) => l.textContent?.includes(text),
      )!;
      return document.getElementById(label.htmlFor) as HTMLInputElement;
    };
    await field(inputFor('Min. % Supply per Sell'), '0.5');
    const minimum = '5000000';
    if (kind.startsWith('strategy')) await click('End Conditions—');
    if (kind.endsWith('tokens')) {
      const group = host.querySelector(
        `[aria-label="${kind.startsWith('session') ? 'Session' : 'Strategy'} maximum unit"]`,
      )!;
      await act(async () =>
        [...group.querySelectorAll('button')]
          .find((b) => b.textContent?.trim() === 'Token amount')!
          .click(),
      );
    }
    await field(
      inputFor(kind.startsWith('session') ? 'Session maximum' : 'Max Amount'),
      kind.endsWith('tokens') ? '4000000' : '0.4',
    );
    expect(hint().textContent).toContain(`Minimum sell is ${minimum} tokens`);
    expect(hint().textContent).toContain(
      `${kind.startsWith('session') ? 'session' : 'strategy'} maximum is 4000000 tokens`,
    );
    expect(button('Run 1 Strategy').disabled).toBe(true);
    const requests = vi.mocked(fetch).mock.calls.length;
    await click('Run 1 Strategy');
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requests);
    expect(host.textContent).toContain('Slippage is fixed at 0.5%');
    await field(
      inputFor(kind.startsWith('session') ? 'Session maximum' : 'Max Amount'),
      kind.endsWith('tokens') ? minimum : '0.5',
    );
    expect(hint().textContent).not.toContain('Increase that maximum');
    expect(hint().textContent).toContain('Choose at least one sell wallet');
  },
);
it('names the invalid strategy beside Run and explains missing wallets after its settings are valid', async () => {
  await act(async () =>
    root.render(<AutoSell project={project} wallets={[]} locked={false} />),
  );
  await click('Auto Sell');
  expect(hint().textContent).toContain(
    'Counter: Replication factor is required',
  );
  expect(button('Run 1 Strategy').disabled).toBe(true);
  await validCounter();
  expect(hint().textContent).toContain('Add a Solana wallet in My wallets');
  expect(button('Choose sell wallets')).toBeUndefined();
  expect(button('Run 1 Strategy').disabled).toBe(true);
});
it('reveals and focuses existing wallet selection without selecting a wallet or starting execution', async () => {
  await act(async () =>
    root.render(
      <AutoSell project={project} wallets={[testWallet]} locked={false} />,
    ),
  );
  await click('Auto Sell');
  await validCounter();
  const advanced = [...host.querySelectorAll('details')].find(
    (d) => d.querySelector('summary')?.textContent === 'Advanced Options',
  )!;
  advanced.open = false;
  const requestCount = vi.mocked(fetch).mock.calls.length;
  await click('Choose sell wallets');
  expect(advanced.open).toBe(true);
  const checkbox = host.querySelector<HTMLInputElement>(
    'fieldset input[type="checkbox"]',
  )!;
  expect(document.activeElement).toBe(checkbox);
  expect(checkbox.checked).toBe(false);
  expect(button('Run 1 Strategy').disabled).toBe(true);
  expect(hint().textContent).toContain('Choose at least one sell wallet');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(requestCount);
  await act(async () => checkbox.click());
  expect(hint().textContent).toContain('1 sell wallet selected');
  expect(hint().textContent).toContain('Enter your vault password');
  await field(
    host.querySelector<HTMLInputElement>('input[type="password"]')!,
    'SYNTHETIC TEST ONLY',
  );
  expect(hint().textContent).toContain('Local settings are complete');
  expect(button('Run 1 Strategy').disabled).toBe(false);
  await act(async () => checkbox.click());
  expect(button('Run 1 Strategy').disabled).toBe(true);
  expect(hint().textContent).toContain('0 sell wallets selected');
});
it.each(['archived', 'chain'] as const)(
  'keeps %s refusal visible before any vault action',
  async (kind) => {
    const changed = structuredClone(project);
    if (kind === 'archived') changed.archived = true;
    else changed.document.token.chain = 'Base';
    await act(async () =>
      root.render(
        <AutoSell project={changed} wallets={[testWallet]} locked={false} />,
      ),
    );
    await click('Auto Sell');
    expect(hint().textContent).toContain(
      kind === 'archived' ? 'project is archived' : 'supports Solana tokens',
    );
    expect(button('Run 1 Strategy').disabled).toBe(true);
  },
);
