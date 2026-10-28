import { expect, it } from 'vitest';
import {
  requireFreshSyntheticOrigin,
  requireOwnedSyntheticJournal,
} from './origin-guard';
const host = `jito-${'a'.repeat(32)}.localhost`;
it('fails closed on nonrandom host, unavailable inventory or any existing database', () => {
  expect(() => requireFreshSyntheticOrigin(host, [])).not.toThrow();
  for (const [name, databases] of [
    ['127.0.0.1', []],
    [host, undefined],
    [host, [{ name: 'unrelated', version: 1 }]],
    [host, [{ name: 'pulseforge.jito-recovery-journal.v1', version: 1 }]],
  ] as const)
    expect(() => requireFreshSyntheticOrigin(name, databases)).toThrow();
});
it('permits cleanup only with exactly the test journal inventory', () => {
  expect(() =>
    requireOwnedSyntheticJournal(host, [
      { name: 'pulseforge.jito-recovery-journal.v1', version: 1 },
    ]),
  ).not.toThrow();
  for (const databases of [
    undefined,
    [],
    [{ name: 'unrelated', version: 1 }],
    [{ name: 'pulseforge.jito-recovery-journal.v1', version: 2 }],
    [
      { name: 'pulseforge.jito-recovery-journal.v1', version: 1 },
      { name: 'other', version: 1 },
    ],
  ])
    expect(() => requireOwnedSyntheticJournal(host, databases)).toThrow();
});
