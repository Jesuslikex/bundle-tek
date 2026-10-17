import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ReferralPanel } from './referral-panel';
vi.stubGlobal('React', React);

it('renders nothing until the referral summary loads', () => {
  expect(renderToStaticMarkup(<ReferralPanel />)).toBe('');
});
