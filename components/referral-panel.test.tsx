import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ReferralPanel } from './referral-panel';
vi.stubGlobal('React', React);

it('renders the shell before the referral summary loads', () => {
  const html = renderToStaticMarkup(<ReferralPanel />);
  expect(html).toContain('Invite people to Bundle');
  expect(html).toContain('You do not have a code yet');
});
