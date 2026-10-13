// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ImportedLotLinks } from './imported-lot-links';
import { ImportedSellAcquisitions } from './imported-sell-acquisitions';
import { SessionEntryOutcomes } from './session-entry-outcomes';
import { TokenOperationHistory } from './token-operation-history';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  acquisitionId as id,
  acquisitionMint as mint,
  acquisitionWallet as address,
} from '../test/imported-sell-acquisition-fixture';
const project = {
  id: id(1),
  revision: 1,
  archived: false,
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: mint,
      decimals: 6,
      name: 'QA',
      symbol: 'QA',
      totalSupplyRaw: '1000000',
      observedAt: '2026-10-13T12:00:00.000Z',
      source: 'fixture.test',
    },
  },
} as ImportedTokenProject;
const wallet = {
  chain: 'Solana',
  address,
  revision: 1,
  label: 'QA',
  archived: false,
  folderId: '',
  role: 'Recipient',
  updatedAt: '2026-10-13T12:00:00.000Z',
} as WorkspaceWallet;
const specs: {
  name: string;
  ui: ReactNode;
  button: string;
  message: string;
}[] = [
  {
    name: 'lot links',
    ui: <ImportedLotLinks project={project} />,
    button: 'Review acquisition history',
    message: 'Acquisition history unavailable. No partial accounting is shown.',
  },
  {
    name: 'sell acquisitions',
    ui: (
      <ImportedSellAcquisitions
        project={project}
        wallet={wallet}
        amount="1"
        locked={false}
        onAmountChange={() => {}}
      />
    ),
    button: 'Review recorded acquisitions',
    message: 'Acquisition history unavailable.',
  },
  {
    name: 'session outcomes',
    ui: <SessionEntryOutcomes project={project} sessionId={id(2)} />,
    button: 'Open current session outcomes',
    message:
      'Session outcomes unavailable. Reload to refresh retained evidence.',
  },
  {
    name: 'operation history',
    ui: <TokenOperationHistory projectId={project.id} revision={1} />,
    button: 'Open token operation history',
    message: 'Operation history unavailable.',
  },
];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
for (const spec of specs)
  for (const status of [200, 503])
    it(`${spec.name} replaces non-JSON ${status} with its product error`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('<html>PRIVATE-UPSTREAM-DIAGNOSTIC</html>', {
              status,
              headers: { 'content-type': 'text/html' },
            }),
        ),
      );
      await act(async () => root.render(spec.ui));
      const button = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === spec.button,
      )!;
      expect(button).toBeTruthy();
      await act(async () => button.click());
      expect(container.querySelector('[role=alert]')?.textContent).toContain(
        spec.message,
      );
      expect(container.textContent).not.toMatch(
        /PRIVATE-UPSTREAM|Unexpected token|JSON\.parse|SyntaxError/,
      );
    });
