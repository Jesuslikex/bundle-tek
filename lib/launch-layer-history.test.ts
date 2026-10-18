import { expect, it } from 'vitest';
import { parseLaunchLayerHistory } from './launch-layer-history';
import { launchLayerFixture } from '../test/launch-layer-fixture';
const fixture = () => ({
  projectId: 'layer-source',
  items: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      projectUpdatedAt: '2026-10-18T03:00:00.123Z',
      createdAt: '2026-10-18T03:01:00.000Z',
      sha256: 'a'.repeat(64),
      target: launchLayerFixture().selection.target,
    },
  ],
  complete: true,
  planningOnly: true,
  fundingAllowed: false,
  signingAllowed: false,
  executionAllowed: false,
});
it('accepts only bounded ordered metadata without granting authority', () => {
  const value = fixture();
  expect(parseLaunchLayerHistory(value, 'layer-source')).toEqual(value);
  for (const bad of [
    { ...value, projectId: 'foreign' },
    { ...value, complete: false },
    { ...value, signingAllowed: true },
    { ...value, items: [...value.items, ...value.items] },
    { ...value, items: Array(101).fill(value.items[0]) },
    {
      ...value,
      items: [{ ...value.items[0], target: { kind: 'new', mint: 'invalid' } }],
    },
    { ...value, items: [{ ...value.items[0], createdAt: 'bad' }] },
  ])
    expect(() => parseLaunchLayerHistory(bad, 'layer-source')).toThrow();
});
it('refuses reversed dates and tied IDs rather than silently reordering evidence', () => {
  const value = fixture(),
    older = { ...value.items[0], id: '00000000-0000-4000-8000-000000000001' };
  expect(
    parseLaunchLayerHistory(
      { ...value, items: [value.items[0], older] },
      'layer-source',
    ).items,
  ).toHaveLength(2);
  expect(() =>
    parseLaunchLayerHistory(
      { ...value, items: [older, value.items[0]] },
      'layer-source',
    ),
  ).toThrow('order');
  expect(() =>
    parseLaunchLayerHistory(
      {
        ...value,
        items: [
          { ...older, createdAt: '2026-10-18T03:00:00.000Z' },
          value.items[0],
        ],
      },
      'layer-source',
    ),
  ).toThrow('order');
});
