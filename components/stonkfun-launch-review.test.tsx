// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StonkfunLaunchReview, fromRaw, toRaw } from './stonkfun-launch-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { pumpMintStorageKey } from '@/lib/pump-mint-vault';

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const plan = {
  ...DEFAULT_LAUNCH_PLAN,
  launchpad: 'StonkFun',
  currency: 'SPYX',
  quoteAddress: SPYX,
};
const project = {
  id: 'stonk-a',
  updatedAt: '2026-10-19T00:00:00.000Z',
  payer: {
    address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    revision: 1,
  },
};
let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  fetcher
    .mockReset()
    .mockImplementation(async () => Response.json({ launches: [] }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const buttons = () => [...container.querySelectorAll('button')];

it('converts quote amounts exactly', async () => {
  expect(toRaw('0.5', 8)).toBe('50000000');
  expect(toRaw('12', 6)).toBe('12000000');
  expect(toRaw('0', 8)).toBe('0');
  expect(() => toRaw('0.123456789', 8)).toThrow(/decimal/);
  expect(() => toRaw('-1', 8)).toThrow();
  expect(fromRaw('50000000', 8)).toBe('0.5');
  expect(fromRaw('1143648933', 8)).toBe('11.43648933');
  expect(fromRaw('0', 6)).toBe('0');
});

it('asks for published metadata and a mint key before any mutating request', async () => {
  await act(async () =>
    root.render(
      <StonkfunLaunchReview project={project} plan={plan} releaseId="" />,
    ),
  );
  expect(container.textContent).toContain(
    'Publish the reviewed image and metadata above first.',
  );
  const prepare = buttons().find(
    (b) => b.textContent === 'Prepare and simulate launch',
  )!;
  expect(prepare.disabled).toBe(true);
  expect(
    buttons().some((b) => b.textContent === 'Generate encrypted mint key'),
  ).toBe(true);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('loads the project mint key without generating or requesting a quote', async () => {
  localStorage.setItem(
    pumpMintStorageKey(project.id),
    JSON.stringify({
      format: 'bundle-pump-mint-v1',
      projectId: project.id,
      mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      encrypted: 'x',
    }),
  );
  await act(async () =>
    root.render(
      <StonkfunLaunchReview
        project={project}
        plan={plan}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  // The stub ciphertext is not a valid vault envelope, so the key is refused, not replaced.
  expect(container.textContent).toContain('could not be read');
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
