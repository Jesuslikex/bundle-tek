// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const prepared = vi.hoisted(() => ({ square: [] as boolean[] }));
vi.mock('@/lib/artwork-prepare', async (load) => ({
  ...(await load<typeof import('@/lib/artwork-prepare')>()),
  prepareArtwork: async (_file: Blob, square: boolean) => {
    prepared.square.push(square);
    // Minimal 1x1 PNG header accepted by inspectArtwork.
    const bytes = new Uint8Array(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    bytes.set([73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1], 12);
    // jsdom's Blob lacks arrayBuffer(); browsers have it.
    return {
      size: bytes.length,
      type: 'image/png',
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Blob;
  },
}));
import { ArtworkUpload } from './artwork-upload';

let container: HTMLDivElement, root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  prepared.square = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ artwork: { url: '/api/artwork/' + 'a'.repeat(64) } }),
      {
        status: 200,
      },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', async () => ({
    width: 1,
    height: 1,
    close() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function pasteEvent(target: EventTarget, files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
  target.dispatchEvent(event);
  return event;
}
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  const alert = container.querySelector('[role=alert]');
  if (alert) throw new Error(alert.textContent ?? '');
};
const image = () =>
  new File([new Uint8Array(4)], 'clip.png', { type: 'image/png' });

it('uploads an image pasted anywhere on the page, cropped 1:1 by default', async () => {
  const onUploaded = vi.fn();
  act(() => root.render(<ArtworkUpload onUploaded={onUploaded} />));
  const event = pasteEvent(document.body, [image()]);
  await flush();
  expect(event.defaultPrevented).toBe(true);
  expect(prepared.square).toEqual([true]);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/artwork',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(onUploaded).toHaveBeenCalledWith('/api/artwork/' + 'a'.repeat(64));
});

it('honours the square toggle and leaves text pastes into inputs alone', async () => {
  const onUploaded = vi.fn();
  act(() =>
    root.render(
      <>
        <input id="name" />
        <ArtworkUpload onUploaded={onUploaded} />
      </>,
    ),
  );
  const input = container.querySelector<HTMLInputElement>('#name')!;
  const textPaste = pasteEvent(input, [image()], 'My Token');
  await flush();
  expect(textPaste.defaultPrevented).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();

  const toggle = container.querySelector<HTMLInputElement>(
    '.artwork-square input',
  )!;
  act(() => toggle.click());
  pasteEvent(document.body, [image()]);
  await flush();
  expect(prepared.square).toEqual([false]);
  expect(onUploaded).toHaveBeenCalledTimes(1);
});

it('ignores pastes without an image', async () => {
  act(() => root.render(<ArtworkUpload onUploaded={vi.fn()} />));
  const event = pasteEvent(document.body, [], 'hello');
  await flush();
  expect(event.defaultPrevented).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('stops listening after unmount', async () => {
  act(() => root.render(<ArtworkUpload onUploaded={vi.fn()} />));
  act(() => root.render(<></>));
  pasteEvent(document.body, [image()]);
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
});
