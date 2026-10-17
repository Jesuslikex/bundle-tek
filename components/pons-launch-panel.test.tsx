import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { PonsLaunchPanel } from './pons-launch-panel';
vi.stubGlobal('React', React);

it('starts with a simulation step and no send button', () => {
  const html = renderToStaticMarkup(<PonsLaunchPanel name="A" symbol="B" />);
  expect(html).toContain('Simulate launch');
  expect(html).not.toContain('Send with my wallet');
});
