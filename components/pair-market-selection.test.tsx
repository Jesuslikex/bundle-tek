// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  usePairMarketSelection,
  usePublishPairMarketSelection,
} from './pair-market-selection';
let roots: Root[] = [],
  nodes: HTMLDivElement[] = [];
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  for (const n of nodes) n.remove();
  roots = [];
  nodes = [];
});
function make() {
  const node = document.createElement('div');
  document.body.appendChild(node);
  nodes.push(node);
  const root = createRoot(node);
  roots.push(root);
  return { node, root };
}
function Publish({
  pair,
  revision = 1,
}: {
  pair: string | null;
  revision?: number;
}) {
  usePublishPairMarketSelection('project', revision, pair);
  return null;
}
function Read({
  project = 'project',
  revision = 1,
}: {
  project?: string;
  revision?: number;
}) {
  const selected = usePairMarketSelection(project, revision);
  return <output>{selected ?? 'unavailable'}</output>;
}
it('shares the exact chart selection only with the matching project revision and clears it on unmount', async () => {
  const source = make(),
    consumer = make();
  await act(async () => {
    source.root.render(<Publish pair="second-pool" />);
    consumer.root.render(
      <>
        <Read />
        <Read project="another" />
        <Read revision={2} />
      </>,
    );
  });
  expect(
    Array.from(consumer.node.querySelectorAll('output')).map(
      (n) => n.textContent,
    ),
  ).toEqual(['second-pool', 'unavailable', 'unavailable']);
  await act(async () => source.root.render(<Publish pair="first-pool" />));
  expect(consumer.node.querySelector('output')?.textContent).toBe('first-pool');
  await act(async () => source.root.render(null));
  expect(consumer.node.querySelector('output')?.textContent).toBe(
    'unavailable',
  );
});
it('does not clear a newer selection when an older publisher unmounts', async () => {
  const old = make(),
    latest = make(),
    consumer = make();
  await act(async () => {
    old.root.render(<Publish pair="old-pool" />);
    consumer.root.render(<Read />);
  });
  await act(async () => latest.root.render(<Publish pair="new-pool" />));
  await act(async () => old.root.render(null));
  expect(consumer.node.textContent).toBe('new-pool');
});
