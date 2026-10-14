import { it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';
it('rejects cross-origin and originless writes, allows same-origin writes and public reads', () => {
  for (const origin of [undefined, 'https://attacker.example'])
    expect(
      proxy(
        new NextRequest('https://bundle.example/api/projects', {
          method: 'POST',
          headers: origin ? { origin } : {},
        }),
      ).status,
    ).toBe(403);
  expect(
    proxy(
      new NextRequest('https://bundle.example/api/projects', {
        method: 'POST',
        headers: { origin: 'https://bundle.example' },
      }),
    ).status,
  ).toBe(200);
  expect(
    proxy(new NextRequest('https://bundle.example/api/launch/metadata/id'))
      .status,
  ).toBe(200);
});
