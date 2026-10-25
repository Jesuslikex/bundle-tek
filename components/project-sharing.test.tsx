import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ProjectSharePanel, SharedProjectsPanel } from './project-sharing';
vi.stubGlobal('React', React);

it('offers an invite link without creating one on render', () => {
  const html = renderToStaticMarkup(<ProjectSharePanel projectId="p1" />);
  expect(html).toContain('Create invite link');
  expect(html).toContain('New invites disclose no wallet assignments');
  expect(html).toContain('Wallet control and signing stay with you');
  expect(html).not.toContain('<code');
});

it('stays hidden until there is an invite or a shared project', () => {
  expect(renderToStaticMarkup(<SharedProjectsPanel />)).toBe('');
});
