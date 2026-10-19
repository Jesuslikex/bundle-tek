// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { LaunchSetupDialog } from './launch-setup-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test('summarises the draft and continues only on request', async () => {
  const onContinue = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(
      <LaunchSetupDialog
        open
        plan={{ ...DEFAULT_LAUNCH_PLAN, ticker: 'DING', holderCount: 7 }}
        modeLabel="Sequenced Mode"
        estimate={{ allocation: 25, scenarioTotal: '3.08' }}
        onOpenChange={() => {}}
        onContinue={onContinue}
      />,
    );
  });
  const text = document.body.textContent ?? '';
  expect(text).toContain('Launch Setup');
  expect(text).toContain('$DING');
  expect(text).toContain('Sequenced Mode');
  expect(text).toContain('25%');
  expect(onContinue).not.toHaveBeenCalled();
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Continue to funding',
  )!;
  await act(async () => button.click());
  expect(onContinue).toHaveBeenCalledOnce();
});
