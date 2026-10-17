// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { TemporaryHoldersPicker } from './temporary-holders-picker';
import { readTemporaryHolders } from '@/lib/temporary-holders';

const A = 'Vote111111111111111111111111111111111111111';
const B = 'Stake11111111111111111111111111111111111111';

it('marks temporary holders per mint, unchecked by default', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(<TemporaryHoldersPicker mint="m1" holders={[A, B]} />),
  );
  const boxes = [
    ...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ];
  expect(boxes.map((b) => b.checked)).toEqual([false, false]);
  await act(async () => boxes[1].click());
  expect(readTemporaryHolders('m1')).toEqual([B]);
  await act(async () => boxes[1].click());
  expect(readTemporaryHolders('m1')).toEqual([]);
  act(() => root.unmount());
});
