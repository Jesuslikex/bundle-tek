import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ProjectDashboard } from './project-dashboard';
vi.stubGlobal('React', React);

const render = (props: Partial<Parameters<typeof ProjectDashboard>[0]> = {}) =>
  renderToStaticMarkup(
    <ProjectDashboard
      projects={[]}
      loading={false}
      busy={false}
      onOpen={() => {}}
      onNew={() => {}}
      onArchive={() => {}}
      onDuplicate={() => {}}
      onReload={() => {}}
      onWallet={() => {}}
      {...props}
    />,
  );

it('shows one sign-in prompt instead of empty-workspace claims when signed out', () => {
  const html = render({
    signedOut: true,
    importsError: 'Sign in to open imported token projects.',
  });
  expect(html).toContain('Sign in to open your workspace');
  expect(html).toContain('href="/signin-with-chatgpt?return_to=/"');
  expect(html).toContain('Sign in to load your imported tokens.');
  expect(html).not.toContain('Your next launch starts here');
  expect(html).not.toContain('0 active imports');
  expect(html).not.toContain('Previously loaded imports may be stale');
  expect(html).not.toContain('<strong>0</strong>');
});

it('keeps the signed-in empty state and styled import note', () => {
  const html = render();
  expect(html).toContain('Your next launch starts here');
  expect(html).not.toContain('Sign in to open your workspace');
  expect(html).toContain('class="library-empty-note">No active imports.');
});

it('counts imported tokens and offers an import as the next step', () => {
  const html = render({ onImport: () => {} });
  expect(html).toContain('<span>Imported tokens</span><strong>0</strong>');
  expect(html).toContain('Paste a token address to open its chart');
  expect(html).not.toContain('Mainnet launches');
  // Signed-out and filtered views never show the import prompt or a zero count.
  const signedOut = render({ onImport: () => {}, signedOut: true });
  expect(signedOut).toContain('<span>Imported tokens</span><strong>—</strong>');
  expect(signedOut).not.toContain('Paste a token address');
  expect(render({ onImport: () => {}, archived: true })).not.toContain(
    'Paste a token address',
  );
});
