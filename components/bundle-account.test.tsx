// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: {
    user: { id: 'owner', email: 'owner@example.com', name: 'Owner' },
  } as { user: { id: string; email: string; name: string } } | null,
  list: vi.fn(),
  link: vi.fn(),
  signOut: vi.fn(),
}));
const route = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.path }));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: mocks.session, isPending: false }),
    listAccounts: mocks.list,
    linkSocial: mocks.link,
    signOut: mocks.signOut,
  }),
}));
import { BundleAccount } from './bundle-account';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  mocks.session = {
    user: { id: 'owner', email: 'owner@example.com', name: 'Owner' },
  };
});
it('links only after an authenticated user clicks, and shows a safe error', async () => {
  mocks.list.mockResolvedValue({ data: [{ providerId: 'credential' }] });
  mocks.link.mockResolvedValue({ error: { message: 'provider failure' } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<BundleAccount googleEnabled />));
  expect(mocks.link).not.toHaveBeenCalled();
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Link Google',
  )!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(mocks.link).toHaveBeenCalledExactlyOnceWith({
    provider: 'google',
    callbackURL: '/',
    errorCallbackURL: '/sign-in?error=google',
  });
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Use the Google account with your Bundle email.',
  );
  expect(button.disabled).toBe(false);
  await act(async () => root.unmount());
});
it('shows an already linked Google account without another linking action', async () => {
  mocks.list.mockResolvedValue({ data: [{ providerId: 'google' }] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<BundleAccount googleEnabled />));
  expect(container.textContent).toContain('Google linked');
  expect(container.textContent).not.toContain('Link Google');
  expect(mocks.link).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
it('does not inspect or link accounts for signed-out users', async () => {
  mocks.session = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<BundleAccount googleEnabled />));
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.link).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
it('does not offer email-matched Google linking for a wallet-only account', async () => {
  mocks.session = {
    user: {
      id: 'solana_test',
      name: 'ABCD…EFGH',
      email: 'placeholder@wallet.bundle.invalid',
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<BundleAccount googleEnabled />));
  expect(container.textContent).toContain('ABCD…EFGH');
  expect(container.textContent).not.toContain('Link Google');
  expect(mocks.list).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
it('stays out of the way on the sign-in page, which has its own form', async () => {
  mocks.session = null;
  route.path = '/sign-in';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<BundleAccount googleEnabled />));
  expect(container.innerHTML).toBe('');
  await act(async () => root.unmount());
});