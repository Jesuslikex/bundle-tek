// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto, createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSellProfiles } from './auto-sell-profiles';
import {
  profileProject,
  profileWallet,
  profileTerms,
  savedProfile,
  profileSummary,
  profileAuthority,
} from '../test/auto-sell-profile-fixture';
import type { SavedAutoSellProfile } from '@/lib/auto-sell-profile';
let host: HTMLDivElement, root: Root;
let requests: {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
}[];
const restore = vi.fn();
let props: Parameters<typeof AutoSellProfiles>[0];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Keep the real SHA256 algorithm but resolve its controlled test promise in
  // the same microtask chain, so React act need not wait on a worker thread.
  vi.stubGlobal('crypto', {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: {
      digest: async (_algorithm: unknown, data: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(data).digest()).buffer,
    },
  });
  localStorage.clear();
  requests = [];
  restore.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) =>
          requests.push({ url, init, resolve, reject }),
        ),
    ),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  props = {
    project: structuredClone(profileProject),
    wallets: [structuredClone(profileWallet)],
    selectedWallets: [profileWallet.address],
    configuration: profileTerms().configuration,
    disabled: false,
    onRestore: restore,
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<AutoSellProfiles {...props} />));
}
async function click(text: string) {
  const b = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!b) throw Error('Missing ' + text);
  await act(async () => b.click());
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
}
async function respond(i: number, body: unknown, status = 200) {
  await act(async () => requests[i].resolve(Response.json(body, { status })));
}
async function settle(n: number) {
  await act(async () => {
    await vi.waitFor(() => expect(requests).toHaveLength(n));
  });
}
async function review(profile: SavedAutoSellProfile) {
  await click('Load saved history');
  await respond(requests.length - 1, {
    profiles: [profileSummary(profile)],
    nextCursor: null,
    ...profileAuthority,
  });
  await click(`Open version ${profile.version} · ${profile.id}`);
  await respond(requests.length - 1, { profile, ...profileAuthority });
  await act(async () => {
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Saved project revision'),
    );
  });
}
it('does no networking, restoration or approval on mount', async () => {
  await render();
  expect(requests).toHaveLength(0);
  expect(restore).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Reloading never resumes Auto Sell');
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
});
it('blocks saving invalid visible settings without blocking saved history or restoration', async () => {
  props.saveBlockedReason = 'Start delay is invalid.';
  props.draftContext = 'invalid-hours';
  await render();
  expect(button('Save current settings as new profile').disabled).toBe(true);
  expect(button('Load saved history').disabled).toBe(false);
  await review(await savedProfile());
  expect(button('Save current settings as version 2').disabled).toBe(true);
  expect(host.textContent).toContain(
    'Complete the current settings before saving',
  );
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Use settings for a new reviewed run');
  expect(restore).toHaveBeenCalledOnce();
  expect(requests.every((r) => !r.init?.method)).toBe(true);
});
it('discloses an omitted saved slippage ceiling before an unchecked restoration review', async () => {
  const terms = profileTerms();
  delete terms.configuration.session.maxSlippageBps;
  await render();
  await review(await savedProfile({ terms }));
  expect(host.textContent).toContain(
    'Restoring uses the existing default of 50 bps',
  );
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
});

it('saves exact current settings with a stable recovery ID and no authority', async () => {
  await render();
  await click('Save current settings as new profile');
  await settle(1);
  const body = JSON.parse(requests[0].init!.body as string);
  expect(body.expectedVersion).toBe(0);
  expect(body.terms.configuration).toEqual(props.configuration);
  expect(body.terms).not.toHaveProperty('password');
  expect(localStorage.length).toBe(1);
  const profile = await savedProfile({
    id: body.id,
    profileId: body.profileId,
    terms: body.terms,
  });
  await respond(0, { profile, ...profileAuthority });
  await act(async () => {
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Configuration saved.'),
    );
  });
  expect(localStorage.length).toBe(0);
  expect(restore).not.toHaveBeenCalled();
  expect(requests).toHaveLength(1);
});
it('recovers a lost save after remount without replaying its POST or adopting the current changed draft', async () => {
  await render();
  await click('Save current settings as new profile');
  await settle(1);
  const body = JSON.parse(requests[0].init!.body as string);
  await act(async () => requests[0].reject(Error('lost response')));
  expect(host.textContent).toContain('Original save ID');
  props = { ...props, configuration: structuredClone(props.configuration) };
  props.configuration.strategies[0].replicationPercent = '90';
  await render();
  expect(button('Save current settings as new profile').disabled).toBe(true);
  await click('Check original save outcome');
  expect(requests[1].url).toContain('id=' + body.id);
  expect(requests[1].init?.method).toBeUndefined();
  await respond(1, {
    profile: await savedProfile({
      id: body.id,
      profileId: body.profileId,
      terms: body.terms,
    }),
    ...profileAuthority,
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Original save found.'),
    );
  });
  expect(requests.filter((r) => r.init?.method === 'POST')).toHaveLength(1);
  expect(restore).not.toHaveBeenCalled();
  expect(host.querySelector('pre')?.textContent).toContain('100');
});
it('requires an initially unchecked review before restoring a stopped draft', async () => {
  await render();
  const profile = await savedProfile();
  await review(profile);
  expect(button('Use settings for a new reviewed run').disabled).toBe(true);
  expect(host.textContent).toContain('No delay');
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Use settings for a new reviewed run');
  expect(restore).toHaveBeenCalledOnce();
  expect(restore.mock.calls[0]).toEqual([profile, [profileWallet.address]]);
  expect(requests.every((r) => !r.init?.method)).toBe(true);
});
it('clears changed wallet selection rather than substituting a wallet', async () => {
  props.wallets = [{ ...profileWallet, revision: 2 }];
  await render();
  await review(await savedProfile());
  expect(host.textContent).toContain('clear wallet selection');
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  await click('Use settings for a new reviewed run');
  expect(restore.mock.calls[0][1]).toEqual([]);
});
it.each(['decimals', 'totalSupplyRaw'] as const)(
  'refuses restoring changed token %s',
  async (field) => {
    const token = props.project.document.token;
    if (field === 'decimals') token.decimals = 8;
    else token.totalSupplyRaw = '999';
    await render();
    await review(await savedProfile());
    expect(host.textContent).toContain('cannot be restored');
    expect(
      host.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled,
    ).toBe(true);
    expect(restore).not.toHaveBeenCalled();
  },
);
it('discards late reads and approval when context changes or becomes blocked', async () => {
  await render();
  const profile = await savedProfile();
  await review(profile);
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
  props = { ...props, disabled: true };
  await render();
  props = { ...props, disabled: false };
  await render();
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  await click('Load saved history');
  const i = requests.length - 1;
  props = { ...props, project: { ...props.project, revision: 2 } };
  await render();
  expect(requests[i].init?.signal?.aborted).toBe(true);
  await respond(i, {
    profiles: [profileSummary(profile)],
    nextCursor: null,
    ...profileAuthority,
  });
  expect(host.textContent).not.toContain('Saved index only');
  expect(restore).not.toHaveBeenCalled();
});
it('refuses hash-corrupted exact reads even if the index looked valid', async () => {
  await render();
  const profile = await savedProfile();
  await click('Load saved history');
  await respond(0, {
    profiles: [profileSummary(profile)],
    nextCursor: null,
    ...profileAuthority,
  });
  await click(`Open version 1 · ${profile.id}`);
  await respond(1, {
    profile: { ...profile, terms: { ...profile.terms, name: 'tampered' } },
    ...profileAuthority,
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(host.querySelector('[role=alert]')).not.toBeNull(),
    );
  });
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  expect(restore).not.toHaveBeenCalled();
});
it('fails closed on HTML and on positive authority flags without retrying', async () => {
  await render();
  await click('Load saved history');
  await act(async () =>
    requests[0].resolve(
      new Response('<html>private</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(host.textContent).not.toContain('<html>');
  await click('Load saved history');
  await respond(1, {
    profiles: [],
    nextCursor: null,
    ...profileAuthority,
    signingAllowed: true,
  });
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  expect(requests).toHaveLength(2);
});

it('offers same-origin sign-in recovery without automatically retrying or losing the draft', async () => {
  await render();
  await click('Load saved history');
  await respond(0, { error: 'signed out' }, 401);
  const link = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
  expect(link.target).toBe('_blank');
  expect(link.rel).toContain('noopener');
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe(
    'Auto Sell configuration',
  );
  expect(requests).toHaveLength(1);
  expect(restore).not.toHaveBeenCalled();
  await click('Load saved history');
  await respond(1, { profiles: [], nextCursor: null, ...profileAuthority });
  expect(host.querySelector('a[href="/sign-in"]')).toBeNull();
});
it('does not send an incomplete wallet selection and retains an in-memory recovery ID when local storage fails', async () => {
  props.selectedWallets = [];
  await render();
  await click('Save current settings as new profile');
  expect(requests).toHaveLength(0);
  expect(host.textContent).toContain('Choose current sell wallets');
  props = { ...props, selectedWallets: [profileWallet.address] };
  await render();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('storage blocked');
  });
  await click('Save current settings as new profile');
  await settle(1);
  await act(async () => requests[0].reject(Error('lost')));
  expect(host.textContent).toContain('Original save ID');
  expect(host.textContent).toContain('Browser storage cannot retain');
});
