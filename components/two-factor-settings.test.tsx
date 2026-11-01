// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  enable: vi.fn(),
  verifyTotp: vi.fn(),
  disable: vi.fn(),
  refetch: vi.fn(),
  user: { twoFactorEnabled: false } as { twoFactorEnabled: boolean },
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: { user: m.user }, refetch: m.refetch }),
    twoFactor: {
      enable: m.enable,
      verifyTotp: m.verifyTotp,
      disable: m.disable,
    },
  }),
}));
import { TwoFactorSettings } from './two-factor-settings';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const set = (input: HTMLInputElement, v: string) => {
  Reflect.set(HTMLInputElement.prototype, 'value', v, input);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;

it('sets up 2FA: password, shows key and backup codes, confirms with a code', async () => {
  m.enable.mockResolvedValue({
    data: {
      totpURI:
        'otpauth://totp/Bundle%20Tek:a@b.co?secret=ABCDEF&issuer=Bundle%20Tek',
      backupCodes: ['code-1', 'code-2'],
    },
  });
  m.verifyTotp.mockResolvedValue({ data: { status: true } });
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<TwoFactorSettings />));
  expect(el.textContent).toContain('Status: Off');
  set(el.querySelector<HTMLInputElement>('input[type=password]')!, 'password1');
  await act(async () => button(el, 'Set up 2FA').click());
  expect(m.enable).toHaveBeenCalledWith({ password: 'password1' });
  expect(
    el.querySelector('[aria-label="Authenticator key"]')?.textContent,
  ).toBe('ABCDEF');
  expect(
    el.querySelector<HTMLTextAreaElement>('[aria-label="Backup codes"]')?.value,
  ).toBe('code-1\ncode-2');
  set(
    el.querySelector<HTMLInputElement>('[aria-label="Authenticator code"]')!,
    '123456',
  );
  await act(async () => button(el, 'Confirm and turn on').click());
  expect(m.verifyTotp).toHaveBeenCalledWith({ code: '123456' });
  expect(m.refetch).toHaveBeenCalled();
  expect(el.textContent).toContain('Two-factor is on');
  await act(async () => root.unmount());
});
