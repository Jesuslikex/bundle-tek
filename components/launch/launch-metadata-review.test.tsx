// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// History intentionally loads three sources on mount and has its own integration
// suite. Keep those independent GETs out of this publisher's consent/retry queue.
vi.mock('./pump-launch-history', () => ({ PumpLaunchHistory: () => null }));
import { LaunchMetadataReview } from './launch-metadata-review';
import { LaunchReviewFocusProvider } from './launch-review-focus';
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
const recoveryFetcher = vi.fn();
const onSave = vi.fn();
const props = { plan, identity, project, onSave };
type Props = Parameters<typeof LaunchMetadataReview>[0];
async function render(changes: Partial<Props> = {}) {
  await act(async () => {
    root.render(<LaunchMetadataReview {...props} {...changes} />);
  });
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  recoveryFetcher.mockReset();
  recoveryFetcher.mockImplementation(async () =>
    Response.json({ release: null }),
  );
  onSave.mockReset();
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? fetcher(url, options)
      : recoveryFetcher(url, options),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('returns focus to the real save button when a save fails', async () => {
  const renderSave = async (saving: boolean) => {
    await act(async () => {
      root.render(
        <LaunchReviewFocusProvider>
          <LaunchMetadataReview
            {...props}
            project={null}
            saving={saving}
            disclosureOpen
          />
        </LaunchReviewFocusProvider>,
      );
    });
  };
  await renderSave(false);
  const initial = container.querySelector<HTMLButtonElement>(
    '[data-review-save-trigger]',
  )!;
  expect(initial).not.toBeNull();
  initial.focus();
  await act(async () => initial.click());
  await renderSave(true);
  await renderSave(false);
  const retry = container.querySelector<HTMLButtonElement>(
    '[data-review-save-trigger]',
  )!;
  expect(retry.disabled).toBe(false);
  expect(document.activeElement).toBe(retry);
  expect(container.querySelector<HTMLDetailsElement>('details')?.open).toBe(
    true,
  );
  expect(onSave).toHaveBeenCalledOnce();
});
it('returns focus to the open real review when a first save remounts it', async () => {
  const renderSave = async (saved: boolean, saving: boolean) => {
    await act(async () => {
      root.render(
        <LaunchReviewFocusProvider>
          <LaunchMetadataReview
            key={saved ? 'saved' : 'draft'}
            {...props}
            project={saved ? project : null}
            saving={saving}
            disclosureOpen
          />
        </LaunchReviewFocusProvider>,
      );
    });
  };
  await renderSave(false, false);
  const save = container.querySelector<HTMLButtonElement>(
    '[data-review-save-trigger]',
  )!;
  save.focus();
  await act(async () => save.click());
  await renderSave(false, true);
  await renderSave(true, false);
  expect(document.activeElement?.tagName).toBe('SUMMARY');
  expect(container.querySelector<HTMLDetailsElement>('details')?.open).toBe(
    true,
  );
  expect(container.querySelector('[data-review-save-trigger]')).toBeNull();
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked,
  ).toBe(false);
});
it('shows the saved public identity with explicit unchecked consent and makes no publication request', async () => {
  await render();
  expect(container.textContent).toContain('Reviewed identity');
  expect(container.textContent).toContain('does not create a coin');
  expect(container.textContent).toContain('cannot be changed or removed');
  expect(button().disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input')!.checked).toBe(
    false,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('recovers the exact published metadata after remount without publishing or granting consent', async () => {
  recoveryFetcher.mockImplementation(async () =>
    Response.json({ release: result() }),
  );
  await render();
  expect(recoveryFetcher).toHaveBeenCalledOnce();
  expect(recoveryFetcher.mock.calls[0][0]).toContain('projectId=project-a');
  expect(recoveryFetcher.mock.calls[0][1].method).toBeUndefined();
  expect(container.textContent).toContain('Metadata published.');
  expect(container.querySelector('a')!.href).toBe(result().uri);
  recoveryFetcher.mockImplementation(async () =>
    Response.json({ release: null }),
  );
  await render({ identity: { ...identity, website: 'https://changed.test' } });
  expect(container.textContent).not.toContain('Metadata published.');
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
});

it('describes pending recovery as a read, not publication', async () => {
  recoveryFetcher.mockImplementation(() => new Promise<Response>(() => {}));
  await render();
  expect(container.textContent).toContain('Checking for published metadata.');
  expect(container.textContent).not.toContain('publication may still');
  expect(recoveryFetcher.mock.calls[0][1].method).toBeUndefined();
});

it('discards a recovery response after the project changes', async () => {
  let finish!: (response: Response) => void;
  recoveryFetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  const signal = recoveryFetcher.mock.calls[0][1].signal as AbortSignal;
  const finishOld = finish;
  await render({ project: { ...project, id: 'another-project' } });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finishOld(Response.json({ release: result() }));
  });
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).not.toContain('Metadata published.');
});

it('refuses a recovered release for a different identity', async () => {
  recoveryFetcher.mockImplementation(async () =>
    Response.json({
      release: {
        ...result(),
        metadata: { ...result().metadata, symbol: 'OTHER' },
      },
    }),
  );
  await render();
  expect(container.textContent).toContain('could not be verified');
  expect(container.textContent).not.toContain('Metadata published.');
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
});
it('times out automatic recovery even if the response body never settles', async () => {
  vi.useFakeTimers();
  recoveryFetcher.mockResolvedValue({
    ok: true,
    json: () => new Promise(() => {}),
  });
  await render();
  expect(container.textContent).toContain('Checking published metadata');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10001);
  });
  expect(recoveryFetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(container.textContent).toContain(
    'Published metadata could not be verified',
  );
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled,
  ).toBe(false);
});
it('requires saved clean context and allows an explicit save instead of publication', async () => {
  await render({ project: null });
  expect(container.querySelector('input')).toBeNull();
  act(() => container.querySelector('button')!.click());
  expect(onSave).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
  await render({ project: null, saving: true });
  expect(container.querySelector('button')!.disabled).toBe(true);
});
it('keeps the disclosure open through saving and resets consent', async () => {
  await render();
  const disclosure = container.querySelector('details')!;
  act(() => {
    disclosure.open = true;
  });
  check();
  expect(button().disabled).toBe(false);
  await render({ project: null, saving: true });
  expect(container.querySelector('details')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  await render({
    project: { ...project, updatedAt: '2026-10-15T00:00:00.000Z' },
  });
  expect(container.querySelector('details')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  expect(button().disabled).toBe(true);
});
it('keeps the disclosure open across first save without restoring consent', async () => {
  function Parent({ saved }: { saved: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <LaunchMetadataReview
        key={saved ? project.id : 'new-project'}
        {...props}
        project={saved ? project : null}
        disclosureOpen={open}
        onDisclosureOpenChange={setOpen}
      />
    );
  }
  act(() => root.render(<Parent saved={false} />));
  act(() => {
    const disclosure = container.querySelector('details')!;
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle'));
  });
  await act(async () => {
    root.render(<Parent saved />);
  });
  expect(container.querySelector('details')!.open).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  act(() => {
    const disclosure = container.querySelector('details')!;
    disclosure.open = false;
    disclosure.dispatchEvent(new Event('toggle'));
  });
  act(() => root.render(<Parent saved={false} />));
  expect(container.querySelector('details')!.open).toBe(false);
});
it('requires uploaded artwork and hides unsupported venue review', async () => {
  await render({
    identity: { ...identity, artworkUrl: 'https://example.com/image.png' },
  });
  expect(container.querySelector<HTMLInputElement>('input')!.disabled).toBe(
    true,
  );
  expect(container.textContent).toContain('Upload an image');
  await render({ plan: { ...plan, launchpad: 'Bags' } });
  expect(container.textContent).toBe('');
});
it('sends only the reviewed project/version/consent and validates the public link', async () => {
  fetcher.mockResolvedValue(Response.json(result()));
  await render();
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
  await render();
  check();
  await click();
  await render({ identity: { ...identity, website: 'https://changed.test' } });
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
  await render();
  check();
  await click();
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  await render({ project: { ...project, id: 'another-project' } });
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
    await render({
      project: { ...project, updatedAt: Math.random().toString() },
    });
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
  await render();
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
  await render();
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
  await render({ plan: { ...plan, launchpad: 'StonkFun', mode: 'Block-0' } });
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
it('does not expose StonkFun planning without a saved project', async () => {
  await render({
    plan: { ...plan, launchpad: 'StonkFun', mode: 'Block-0' },
    project: null,
  });
  expect(
    container.querySelector('[aria-label="StonkFun Front-wallet planning"]'),
  ).toBeNull();
});

it('offers the explicit existing-token picker separately from new-token preparation', async () => {
  await render({ plan: { ...plan, mode: 'Block-0', scheduled: true } });
  expect(
    container.querySelector('[aria-label="Existing-token layer planning"]'),
  ).not.toBeNull();
  expect(container.querySelector('select')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
