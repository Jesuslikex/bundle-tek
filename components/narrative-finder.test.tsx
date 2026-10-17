import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { NarrativeFinder } from './narrative-finder';
vi.stubGlobal('React', React);

it('renders the heading and the approval note before the feed loads', () => {
  const html = renderToStaticMarkup(<NarrativeFinder onDraft={() => {}} />);
  expect(html).toContain('Trending narratives');
  expect(html).toContain('nothing launches until you review and approve it');
});
