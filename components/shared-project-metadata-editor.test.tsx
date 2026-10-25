// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SharedProjectMetadataEditor,
  SharedProjectMetadataRecovery,
} from './shared-project-metadata-editor';
import {
  metadataEditReviewHash,
  type MetadataEditSource,
} from '@/lib/project-collaboration-metadata';

const props = {
  projectId: 'project-a',
  shareId: '11111111-1111-4111-8111-111111111111',
  projectUpdatedAt: '2026-10-25T12:00:00.000Z',
};
const mutationId = '22222222-2222-4222-8222-222222222222';
const storageKey = `bundle-shared-metadata-edit:${props.shareId}:${props.projectId}`;
const source: MetadataEditSource = {
  format: 'shared-project-metadata-source-v1',
  ...props,
  expiresAt: '2026-10-26T12:00:00.000Z',
  values: {
    tokenName: 'Original name',
    ticker: 'OLD',
    description: 'Original description',
  },
  editingAllowed: true,
  walletActionsAllowed: false,
  signingAllowed: false,
  publishingAllowed: false,
};
const after = {
  tokenName: 'Updated name',
  ticker: 'NEW',
  description: 'Updated description',
};
let root: Root, container: HTMLDivElement;
let requests: {
  url: string;
  init: RequestInit;
  resolve: (value: Response) => void;
  reject: (reason: Error) => void;
}[];
const fetcher = vi.fn();
async function settle() {
  await act(async () => {
    for (let i = 0; i < 18; i++) await Promise.resolve();
  });
}
async function render(
  extra: Partial<Parameters<typeof SharedProjectMetadataEditor>[0]> = {},
) {
  await act(async () =>
    root.render(<SharedProjectMetadataEditor {...props} {...extra} />),
  );
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find(
    (node) => node.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
async function respond(index: number, value: unknown, status = 200) {
  await act(async () =>
    requests[index].resolve(Response.json(value, { status })),
  );
  await settle();
}
async function load() {
  await click('Load current saved text');
  await respond(requests.length - 1, source);
}
async function edit(suffix = '') {
  await act(async () => {
    const name = container.querySelector('input:not([type=checkbox])')!;
    const ticker = container.querySelectorAll('input:not([type=checkbox])')[1];
    const description = container.querySelector('textarea')!;
    for (const [node, value] of [
      [name, `  Updated name${suffix}  `],
      [ticker, ' new '],
      [description, ' Updated description '],
    ] as const) {
      Object.getOwnPropertyDescriptor(
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      )!.set!.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
async function review() {
  await load();
  await edit();
  await click('Review text changes');
}
async function approve() {
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
}
async function receipt() {
  return {
    format: 'shared-project-metadata-edit-receipt-v1',
    mutationId,
    shareId: props.shareId,
    projectId: props.projectId,
    beforeUpdatedAt: props.projectUpdatedAt,
    updatedAt: '2026-10-25T12:00:01.000Z',
    createdAt: '2026-10-25T12:00:01.000Z',
    reviewHash: await metadataEditReviewHash(source, after),
    before: source.values,
    after,
    metadataSaved: true,
    walletActionsAllowed: false,
    signingAllowed: false,
    publishingAllowed: false,
  };
}
async function reminder() {
  return {
    mutationId,
    shareId: props.shareId,
    projectId: props.projectId,
    reviewHash: await metadataEditReviewHash(source, after),
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID: () => mutationId,
    subtle: {
      digest: async (_algorithm: unknown, input: BufferSource) => {
        const data = ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
        return Uint8Array.from(createHash('sha256').update(data).digest())
          .buffer;
      },
    },
  });
  localStorage.clear();
  requests = [];
  fetcher
    .mockReset()
    .mockImplementation(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) =>
          requests.push({ url, init, resolve, reject }),
        ),
    );
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not fetch on mount or disclosure and discloses the limited saved-text scope', async () => {
  await render();
  expect(container.querySelector('details')!.open).toBe(false);
  await act(async () => container.querySelector('summary')!.click());
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain('grants no wallet');
  await click('Load current saved text');
  expect(requests[0].url).toBe(
    `/api/projects/collaboration/metadata?shareId=${props.shareId}`,
  );
  expect(requests[0].init.cache).toBe('no-store');
});
it('requires exact canonical review and separate unchecked approval before a one-attempt save', async () => {
  await render();
  await review();
  expect(container.textContent).toContain('After: Updated name');
  expect(container.textContent).toContain('After: NEW');
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  expect(button('Save reviewed text once').disabled).toBe(true);
  expect(requests).toHaveLength(1);
  await approve();
  await click('Save reviewed text once');
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1].init.body as string)).toEqual({
    action: 'save',
    ...(await reminder()),
    expectedUpdatedAt: props.projectUpdatedAt,
    values: after,
    approved: true,
  });
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(
    await reminder(),
  );
  expect(localStorage.getItem(storageKey)).not.toContain('Updated');
  await respond(1, await receipt());
  expect(container.textContent).toContain('Saved text edit recorded');
  expect(container.textContent).toContain('2026-10-25T12:00:01.000Z');
  expect(localStorage.getItem(storageKey)).toBeNull();
});
it('synchronously blocks repeated save clicks before React rerenders', async () => {
  await render();
  await review();
  await approve();
  await act(async () => {
    button('Save reviewed text once').click();
    button('Save reviewed text once').click();
  });
  expect(requests.filter((r) => r.init.method === 'POST')).toHaveLength(1);
});
it('clears the exact review and consent after input changes', async () => {
  await render();
  await review();
  await approve();
  await edit(' again');
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(button('Save reviewed text once')).toBeUndefined();
  expect(requests).toHaveLength(1);
});
it.each([
  { projectId: 'other-project' },
  { shareId: '33333333-3333-4333-8333-333333333333' },
  { projectUpdatedAt: '2026-10-25T12:00:01.000Z' },
])(
  'rejects a loaded source outside the current context: %s',
  async (changed) => {
    await render();
    await click('Load current saved text');
    await respond(0, { ...source, ...changed });
    expect(container.textContent).toContain('Refresh shared projects');
    expect(container.querySelector('textarea')).toBeNull();
  },
);
it('holds a lost reply through a missing receipt and accepts only the verified original receipt', async () => {
  await render();
  await review();
  await approve();
  await click('Save reviewed text once');
  await act(async () =>
    requests[1].reject(new Error('Network request failed')),
  );
  await settle();
  expect(localStorage.getItem(storageKey)).not.toBeNull();
  expect(button('Load current saved text').disabled).toBe(true);
  await click('Check original edit');
  expect(requests[2].url).toContain(`?mutationId=${mutationId}`);
  await respond(2, { receipt: null });
  expect(container.textContent).toContain('original request may still finish');
  expect(button('Load current saved text').disabled).toBe(true);
  await click('Check original edit');
  await respond(3, { receipt: await receipt() });
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(requests.filter((r) => r.init.method === 'POST')).toHaveLength(1);
});
it('recovers an ID-only reminder after reload without an automatic request or new save', async () => {
  localStorage.setItem(storageKey, JSON.stringify(await reminder()));
  await render();
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain(mutationId);
  await click('Check original edit');
  await respond(0, { receipt: await receipt() });
  expect(container.textContent).toContain('Saved text edit recorded');
  expect(requests[0].init.method).toBeUndefined();
});
it.each(['identity', 'hash', 'values'])(
  'retains an original reminder on a mismatched receipt: %s',
  async (kind) => {
    localStorage.setItem(storageKey, JSON.stringify(await reminder()));
    await render();
    await click('Check original edit');
    const value = await receipt();
    await respond(0, {
      receipt:
        kind === 'identity'
          ? { ...value, mutationId: '33333333-3333-4333-8333-333333333333' }
          : kind === 'hash'
            ? { ...value, reviewHash: 'a'.repeat(64) }
            : { ...value, after: { ...after, tokenName: 'Different' } },
    });
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    expect(container.textContent).not.toContain('Saved text edit recorded');
    expect(button('Load current saved text').disabled).toBe(true);
  },
);
it('sends no save if the ID-only reminder cannot be persisted', async () => {
  await render();
  await review();
  await approve();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Storage unavailable');
  });
  await click('Save reviewed text once');
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain('Storage unavailable');
});
it('refuses overwriting an original edit retained by another tab', async () => {
  await render();
  await review();
  await approve();
  localStorage.setItem(storageKey, JSON.stringify(await reminder()));
  await click('Save reviewed text once');
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain('original edit still needs checking');
});
it('drops a late loaded source when the parent context changes and aborts the read', async () => {
  await render();
  await click('Load current saved text');
  const signal = requests[0].init.signal!;
  await render({ projectUpdatedAt: '2026-10-25T13:00:00.000Z' });
  expect(signal.aborted).toBe(true);
  await respond(0, source);
  expect(container.querySelector('textarea')).toBeNull();
  expect(requests).toHaveLength(1);
});
it('retains a pending write reminder across parent revision changes without retrying', async () => {
  await render();
  await review();
  await approve();
  await click('Save reviewed text once');
  await render({ projectUpdatedAt: '2026-10-25T13:00:00.000Z' });
  await respond(1, await receipt());
  expect(container.textContent).not.toContain('Saved text edit recorded');
  expect(localStorage.getItem(storageKey)).not.toBeNull();
  expect(requests).toHaveLength(2);
});
it('shows safe errors for HTML and keeps the entered draft', async () => {
  await render();
  await review();
  await approve();
  await click('Save reviewed text once');
  await act(async () =>
    requests[1].resolve(
      new Response('<html>private raw parser text</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  await settle();
  expect(container.textContent).not.toContain('private raw parser text');
  expect(
    container.querySelector<HTMLInputElement>('input:not([type=checkbox])')!
      .value,
  ).toContain('Updated name');
  expect(localStorage.getItem(storageKey)).not.toBeNull();
});
it.each([401, 403, 409])(
  'holds an attempted save on an authorization/revision refusal %s',
  async (status) => {
    await render();
    await review();
    await approve();
    await click('Save reviewed text once');
    await respond(1, { error: 'do not expose' }, status);
    expect(container.textContent).not.toContain('do not expose');
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    expect(button('Load current saved text').disabled).toBe(true);
  },
);
it('never starts requests while locked', async () => {
  await render({ locked: true });
  expect(button('Load current saved text').disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('allows the original receipt GET while locked but leaves all editing disabled', async () => {
  localStorage.setItem(storageKey, JSON.stringify(await reminder()));
  await render({ locked: true });
  expect(button('Load current saved text').disabled).toBe(true);
  expect(button('Check original edit').disabled).toBe(false);
  await click('Check original edit');
  await respond(0, { receipt: await receipt() });
  expect(container.textContent).toContain('Saved text edit recorded');
  expect(requests[0].init.method).toBeUndefined();
  expect(button('Load current saved text').disabled).toBe(true);
});

async function recovery(activeShareIds: string[] = []) {
  await act(async () =>
    root.render(
      <SharedProjectMetadataRecovery activeShareIds={activeShareIds} />,
    ),
  );
  await settle();
}

it('renders nothing when no orphan edit reminders exist and never fetches automatically', async () => {
  await recovery();
  expect(container.textContent).toBe('');
  localStorage.setItem(storageKey, JSON.stringify(await reminder()));
  await recovery([props.shareId]);
  expect(container.textContent).toBe('');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['expired', 'revoked'])(
  'recovers a past own edit after an %s accepted share disappears without restoring edit authority',
  async () => {
    localStorage.setItem(storageKey, JSON.stringify(await reminder()));
    await recovery([props.shareId]);
    expect(container.textContent).toBe('');
    await recovery([]);
    expect(container.textContent).toContain(props.shareId);
    expect(container.textContent).toContain(props.projectId);
    expect(container.textContent).not.toContain(source.values.tokenName);
    expect(button('Load current saved text')).toBeUndefined();
    expect(button('Save reviewed text once')).toBeUndefined();
    expect(container.querySelector('textarea')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    await click('Check original edit');
    await respond(0, { receipt: null });
    expect(container.textContent).toContain(
      'original request may still finish',
    );
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    await click('Check original edit');
    await respond(1, { receipt: await receipt() });
    expect(container.textContent).toContain('Saved text edit recorded');
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(requests.every((request) => request.init.method === undefined)).toBe(
      true,
    );
    await click('Refresh local edit IDs');
    expect(container.textContent).toBe('');
  },
);

it('refreshes cross-tab reminders only through a local scan and keeps invalid records private and unchanged', async () => {
  localStorage.setItem(storageKey, JSON.stringify(await reminder()));
  await recovery();
  const second = {
    ...(await reminder()),
    shareId: '33333333-3333-4333-8333-333333333333',
    projectId: 'project-b',
  };
  const secondKey = `bundle-shared-metadata-edit:${second.shareId}:${second.projectId}`;
  localStorage.setItem(secondKey, JSON.stringify(second));
  expect(container.textContent).not.toContain('project-b');
  await click('Refresh local edit IDs');
  expect(container.textContent).toContain('project-b');
  localStorage.setItem(secondKey, '<private invalid record>');
  await click('Refresh local edit IDs');
  expect(container.textContent).toContain(
    'Some retained edit IDs cannot be read',
  );
  expect(container.textContent).not.toContain('private invalid record');
  expect(localStorage.getItem(secondKey)).toBe('<private invalid record>');
  expect(fetcher).not.toHaveBeenCalled();
});

it('holds a corrupt reminder without exposing its parser contents or sending requests', async () => {
  localStorage.setItem(storageKey, '<private malformed saved contents>');
  await render();
  expect(container.textContent).toContain(
    'original edit reminder cannot be read',
  );
  expect(container.textContent).not.toContain(
    'private malformed saved contents',
  );
  expect(button('Load current saved text').disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('clears approval when the parent revision changes without fetching or posting', async () => {
  await render();
  await review();
  await approve();
  await render({ projectUpdatedAt: '2026-10-25T13:00:00.000Z' });
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(container.querySelector('textarea')).toBeNull();
  expect(requests).toHaveLength(1);
});

it('keeps a changed recovery reminder when the original receipt arrives', async () => {
  await render();
  await review();
  await approve();
  await click('Save reviewed text once');
  const other = {
    ...(await reminder()),
    mutationId: '33333333-3333-4333-8333-333333333333',
  };
  localStorage.setItem(storageKey, JSON.stringify(other));
  await respond(1, await receipt());
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(other);
  expect(container.textContent).toContain('Another tab changed');
  expect(button('Load current saved text').disabled).toBe(true);
  await click('Check original edit');
  expect(requests[2].url).toContain(other.mutationId);
});
