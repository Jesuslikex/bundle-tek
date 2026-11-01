// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: { user: { id: 'u' }, session: { token: 'me' } },
      isPending: false,
    }),
    ...mocks,
  }),
}));
import { UserSettingsPanel } from './user-settings-panel';
import { readUserSettings, USER_SETTINGS_KEY } from '@/lib/user-settings';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
});
async function mount() {
  mocks.listSessions.mockResolvedValue({
    data: [
      {
        id: '1',
        token: 'me',
        userAgent: 'This',
        updatedAt: '2026-11-01T00:00:00Z',
      },
      {
        id: '2',
        token: 'other',
        userAgent: 'Phone',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    ],
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => createRoot(el).render(<UserSettingsPanel />));
  return el;
}
it('saves toggles to this browser', async () => {
  const el = await mount();
  const instant = el.querySelector<HTMLInputElement>('input[aria-label="Instant Trade"]')!;
  await act(async () => instant.click());
  expect(readUserSettings().tradePanel.instantTrade).toBe(true);
  expect(localStorage.getItem(USER_SETTINGS_KEY)).toContain(
    '"instantTrade":true',
  );
});
it('switching layout rebinds hotkeys and applies a theme preset', async () => {
  const el = await mount();
  const az = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'AZERTY',
  )!;
  await act(async () => az.click());
  expect(readUserSettings().hotkeys.buyKeys[0]).toBe('a');
  const light = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Light',
  )!;
  await act(async () => light.click());
  expect(readUserSettings().theme.preset).toBe('Light');
});
it('lists sessions and revokes another device only', async () => {
  mocks.revokeSession.mockResolvedValue({});
  const el = await mount();
  expect(el.textContent).toContain('This device');
  const logOut = [...el.querySelectorAll('button')].filter(
    (b) => b.textContent === 'Log out',
  );
  expect(logOut).toHaveLength(1);
  await act(async () => logOut[0].click());
  expect(mocks.revokeSession).toHaveBeenCalledWith({ token: 'other' });
  expect(el.textContent).not.toContain('Phone');
});
