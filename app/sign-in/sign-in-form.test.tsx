/** @vitest-environment jsdom */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, it, expect, vi } from 'vitest';
const { social, email, verifyTotp, verifyBackupCode } = vi.hoisted(() => ({
  social: vi.fn(),
  email: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    signIn: { social, email },
    signUp: { email: vi.fn() },
    twoFactor: { verifyTotp, verifyBackupCode },
  }),
}));
import { SignInForm } from './sign-in-form';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  social.mockReset();
  document.body.innerHTML = '';
});
it('starts Google login with a fixed local callback and renders a safe failure', async () => {
  social.mockResolvedValue({
    error: { message: 'Google sign-in is temporarily unavailable.' },
  });
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(<SignInForm googleEnabled />));
  const button = Array.from(element.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Continue with Google'),
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  expect(social).toHaveBeenCalledExactlyOnceWith({
    provider: 'google',
    callbackURL: '/',
    errorCallbackURL: '/sign-in?error=google',
  });
  expect(element.querySelector('[role=alert]')?.textContent).toBe(
    'Google sign-in is temporarily unavailable.',
  );
  expect(button.disabled).toBe(false);
  await act(async () => root.unmount());
});
it('keeps email available and does not advertise an unconfigured Google provider', async () => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(<SignInForm googleEnabled={false} />));
  expect(element.textContent).not.toContain('Continue with Google');
  expect(element.querySelector('input[type=email]')).toBeTruthy();
  await act(async () => root.unmount());
});
it('offers a way back to the app without signing in', async () => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(<SignInForm googleEnabled={false} />));
  const back = Array.from(element.querySelectorAll('a')).find((a) =>
    a.textContent?.includes('Continue without signing in'),
  );
  expect(back?.getAttribute('href')).toBe('/');
  await act(async () => root.unmount());
});
it('requires eight characters only for account creation, not existing sign-in', async () => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(<SignInForm googleEnabled={false} />));
  const password = () =>
    element.querySelector<HTMLInputElement>('input[name="password"]')!;
  expect(password().hasAttribute('minlength')).toBe(false);
  expect(password().autocomplete).toBe('current-password');
  const toggle = Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent === 'Create an account',
  )!;
  await act(async () => toggle.click());
  expect(password().minLength).toBe(8);
  expect(password().autocomplete).toBe('new-password');
  expect(element.querySelector('#account-password-help')?.textContent).toBe(
    'Use at least 8 characters.',
  );
  expect(password().getAttribute('aria-describedby')).toBe(
    'account-password-help',
  );
  await act(async () => toggle.click());
  expect(password().hasAttribute('minlength')).toBe(false);
  expect(element.querySelector('#account-password-help')).toBeNull();
  await act(async () => root.unmount());
});
it('asks for an authenticator code after a 2FA password sign-in, then signs in', async () => {
  email.mockResolvedValue({ data: { twoFactorRedirect: true } });
  verifyTotp.mockResolvedValue({ data: { token: 't' } });
  const assign = vi.fn();
  vi.stubGlobal('location', { assign });
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(<SignInForm googleEnabled={false} />));
  const set = (input: HTMLInputElement, v: string) => {
    Reflect.set(HTMLInputElement.prototype, 'value', v, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set(element.querySelector<HTMLInputElement>('input[type=email]')!, 'a@b.co');
  set(
    element.querySelector<HTMLInputElement>('input[type=password]')!,
    'password1',
  );
  await act(async () => element.querySelector('form')!.requestSubmit());
  expect(assign).not.toHaveBeenCalled();
  expect(element.textContent).toContain('Two-factor check');
  set(element.querySelector<HTMLInputElement>('input[name=code]')!, '123456');
  await act(async () => element.querySelector('form')!.requestSubmit());
  expect(verifyTotp).toHaveBeenCalledWith({
    code: '123456',
    trustDevice: false,
  });
  expect(assign).toHaveBeenCalledWith('/');
  vi.unstubAllGlobals();
  await act(async () => root.unmount());
});
