/** @vitest-environment jsdom */
import {createRoot} from 'react-dom/client';
import {act} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
const social=vi.hoisted(()=>vi.fn());
vi.mock('better-auth/react',()=>({createAuthClient:()=>({signIn:{social},signUp:{email:vi.fn()}})}));
import {SignInForm} from './sign-in-form';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{social.mockReset();document.body.innerHTML='';});
it('starts Google login with a fixed local callback and renders a safe failure',async()=>{
 social.mockResolvedValue({error:{message:'Google sign-in is temporarily unavailable.'}});
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 await act(async()=>root.render(<SignInForm googleEnabled />));
 const button=Array.from(element.querySelectorAll('button')).find(b=>b.textContent?.includes('Continue with Google'))!;
 expect(button).toBeTruthy();
 await act(async()=>button.click());
 expect(social).toHaveBeenCalledExactlyOnceWith({provider:'google',callbackURL:'/',errorCallbackURL:'/sign-in?error=google'});
 expect(element.querySelector('[role=alert]')?.textContent).toBe('Google sign-in is temporarily unavailable.');expect(button.disabled).toBe(false);
 await act(async()=>root.unmount());
});
it('keeps email available and does not advertise an unconfigured Google provider',async()=>{
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 await act(async()=>root.render(<SignInForm googleEnabled={false} />));
 expect(element.textContent).not.toContain('Continue with Google');expect(element.querySelector('input[type=email]')).toBeTruthy();
 await act(async()=>root.unmount());
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