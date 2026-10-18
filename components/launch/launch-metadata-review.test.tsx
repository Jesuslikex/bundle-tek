// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// History intentionally loads three sources on mount and has its own integration
// suite. Keep those independent GETs out of this publisher's consent/retry queue.
vi.mock('./pump-launch-history', () => ({ PumpLaunchHistory: () => null }));
import { LaunchMetadataReview } from './launch-metadata-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { EMPTY_IDENTITY } from '@/lib/workspace-project';
let container: HTMLDivElement, root: Root;
const plan = {
  ...DEFAULT_LAUNCH_PLAN,
  tokenName: 'Example',
  ticker: 'EX',
  description: 'Reviewed identity',
};
const identity = {
  ...EMPTY_IDENTITY,
  artworkUrl: `/api/artwork/${'b'.repeat(64)}`,
  website: 'https://example.com',
};
const project = { id: 'project-a', updatedAt: '2026-10-14T00:00:00.000Z' };
const fetcher = vi.fn();
const onSave = vi.fn();
const props = { plan, identity, project, onSave };
type Props = Parameters<typeof LaunchMetadataReview>[0];
function render(changes: Partial<Props> = {}) {
  act(() => root.render(<LaunchMetadataReview {...props} {...changes} />));
}
const button = () =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Publish reviewed metadata',
  )!;
const check = () =>
  act(() =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
const click = async () => {
  await act(async () => {
    button().click();
  });
};
const result = () => {
  const id = 'a'.repeat(64),
    uri = `${window.location.origin}/api/launch/metadata/${id}`;
  return {
    id,
    uri,
    executionAllowed: false,
    metadata: {
      name: plan.tokenName,
      symbol: plan.ticker,
      description: plan.description,
      website: identity.website,
      image: `${uri}/image`,
    },
  };
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetcher.mockReset();
  onSave.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('shows the saved public identity with explicit unchecked consent and makes no publication request', () => {
  render();
  expect(container.textContent).toContain('Reviewed identity');
  expect(container.textContent).toContain('does not create a coin');
  expect(container.textContent).toContain('cannot be changed or removed');
  expect(button().disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input')!.checked).toBe(
    false,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires saved clean context and allows an explicit save instead of publication', () => {
  render({ project: null });
  expect(container.querySelector('input')).toBeNull();
  act(() => container.querySelector('button')!.click());
  expect(onSave).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
  render({ project: null, saving: true });
  expect(container.querySelector('button')!.disabled).toBe(true);
});
it('requires uploaded artwork and hides unsupported venue review', () => {
  render({
    identity: { ...identity, artworkUrl: 'https://example.com/image.png' },
  });
  expect(container.querySelector<HTMLInputElement>('input')!.disabled).toBe(
    true,
  );
  expect(container.textContent).toContain('Upload an image');
  render({ plan: { ...plan, launchpad: 'LetsBonk' } });
  expect(container.textContent).toBe('');
});
it('sends only the reviewed project/version/consent and validates the public link', async () => {
  fetcher.mockResolvedValue(Response.json(result()));
  render();
  check();
  await click();
  expect(fetcher).toHaveBeenCalledOnce();
  const [path, options] = fetcher.mock.calls[0];
  expect(path).toBe('/api/launch/metadata');
  expect(JSON.parse(options.body)).toEqual({
    projectId: project.id,
    updatedAt: project.updatedAt,
    publishPublicly: true,
  });
  expect(container.querySelector('a')!.href).toBe(result().uri);
  expect(container.textContent).toContain(
    'Coin creation still requires a separate transaction review',
  );
  expect(
    container.querySelector('[aria-label="PumpFun holder launch review"]'),
  ).not.toBeNull();
  expect(button()).toBeUndefined();
});
it('resets consent and released links after the reviewed identity changes', async () => {
  fetcher.mockResolvedValue(Response.json(result()));
  render();
  check();
  await click();
  render({ identity: { ...identity, website: 'https://changed.test' } });
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input')!.checked).toBe(
    false,
  );
  expect(button().disabled).toBe(true);
});
it('aborts and ignores a late response after switching project context', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  render();
  check();
  await click();
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  render({ project: { ...project, id: 'another-project' } });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(Response.json(result()));
  });
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).not.toContain('Metadata published.');
});
it('rejects a mismatched public URL or metadata instead of presenting a successful launch', async () => {
  for (const bad of [
    { ...result(), uri: 'https://attacker.test/x' },
    { ...result(), executionAllowed: true },
    {
      ...result(),
      metadata: { ...result().metadata, name: 'Different token' },
    },
  ]) {
    render({ project: { ...project, updatedAt: Math.random().toString() } });
    fetcher.mockResolvedValue(Response.json(bad));
    check();
    await click();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[role=alert]')!.textContent).toContain(
      'may have completed',
    );
  }
});
it('sanitizes HTML errors and retries metadata publication only on explicit same-draft approval', async () => {
  fetcher
    .mockResolvedValueOnce(
      new Response('<html>secret diagnostic</html>', { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json(result()));
  render();
  check();
  await click();
  expect(container.textContent).not.toContain('secret diagnostic');
  expect(container.textContent).not.toContain('Unexpected token');
  expect(container.querySelector('[role=alert]')!.textContent).toContain(
    'Retry this same saved draft',
  );
  expect(fetcher).toHaveBeenCalledOnce();
  await click();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(container.querySelector('a')).not.toBeNull();
});
it('times out even if the response body reader ignores cancellation', async () => {
  vi.useFakeTimers();
  fetcher.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
  render();
  check();
  await click();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25001);
  });
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(container.querySelector('[role=alert]')!.textContent).toContain(
    'may have completed',
  );
  expect(button().disabled).toBe(false);
});

it('exposes a separate Front-only StonkFun planner without the Pump financial handler', async () => {
  render({ plan: { ...plan, launchpad: 'StonkFun', mode: 'Block-0' } });
  expect(
    container.querySelector('[aria-label="StonkFun Front-wallet planning"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain(
    'StonkFun has no Back or temporary layer',
  );
  expect(
    container.querySelector('[aria-label="PumpFun launch review"]'),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not expose StonkFun planning without a saved project', () => {
  render({
    plan: { ...plan, launchpad: 'StonkFun', mode: 'Block-0' },
    project: null,
  });
  expect(
    container.querySelector('[aria-label="StonkFun Front-wallet planning"]'),
  ).toBeNull();
});
