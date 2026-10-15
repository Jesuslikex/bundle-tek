import { beforeAll, expect, it } from 'vitest';
import { pumpGroupBroadcastClientFixture } from '../test/pump-group-broadcast-client-fixture';
import { pumpTokenWorkspaceFixture } from '../test/pump-launch-token-workspace-fixture';
import {
  parsePumpLaunchTokenWorkspace,
  pumpLaunchWorkspaceReady,
} from './pump-launch-token-workspace';
import { parsePumpGroupRequest } from './pump-launch-group-request';
let f: Awaited<ReturnType<typeof pumpGroupBroadcastClientFixture>>,
  view: ReturnType<typeof pumpTokenWorkspaceFixture>;
beforeAll(async () => {
  f = await pumpGroupBroadcastClientFixture();
  view = pumpTokenWorkspaceFixture(f.group);
}, 120000);
it('admits the exact finalized launch workspace without granting execution, signing or reservation changes', () => {
  expect(pumpLaunchWorkspaceReady(view.group)).toBe(true);
  expect(
    parsePumpLaunchTokenWorkspace(
      JSON.parse(JSON.stringify(view.result)),
      view.group,
    ),
  ).toEqual(view.result);
  expect(pumpLaunchWorkspaceReady(f.group)).toBe(false);
  expect(() => parsePumpLaunchTokenWorkspace(view.result, f.group)).toThrow();
});
it('preserves an existing archived workspace and its explicit trade settings without restoring it', () => {
  const result = structuredClone(view.result);
  result.created = false;
  result.project.archived = true;
  result.project.revision = 2;
  result.project.document.tradeSettings = {
    side: 'Sell',
    amount: '10',
    wallet: f.group.review.input.create.payer,
    walletRevision: 1,
  };
  expect(parsePumpLaunchTokenWorkspace(result, view.group)).toEqual(result);
});
it('rejects substituted launch identity, asset, project revision and permission claims', () => {
  for (const patch of [
    { reviewId: crypto.randomUUID() },
    { contextSha256: 'c'.repeat(64) },
    { mint: f.group.review.input.create.payer },
    { signedGroupSha256: 'd'.repeat(64) },
    { executionAllowed: true },
    { signingAllowed: true },
    { reservationsChanged: true },
    { project: { ...view.result.project, revision: 0 } },
    { project: { ...view.result.project, archived: true } },
  ])
    expect(() =>
      parsePumpLaunchTokenWorkspace({ ...view.result, ...patch }, view.group),
    ).toThrow();
  const swapped = structuredClone(view.result);
  swapped.project.document.token.address = f.group.review.input.create.payer;
  expect(() => parsePumpLaunchTokenWorkspace(swapped, view.group)).toThrow();
});
it('admits only the owner-scoped action and group ID, never a client mint or provider endpoint', () => {
  expect(
    parsePumpGroupRequest(
      { action: 'token-workspace', id: f.group.review.id },
      'https://bundle.test',
    ),
  ).toEqual({ action: 'token-workspace', id: f.group.review.id });
  for (const patch of [
    { mint: f.group.review.input.create.mint },
    { ownerId: 'other' },
    { endpoint: 'https://other.test' },
    { document: view.result.project.document },
  ])
    expect(() =>
      parsePumpGroupRequest(
        { action: 'token-workspace', id: f.group.review.id, ...patch },
        'https://bundle.test',
      ),
    ).toThrow();
});
