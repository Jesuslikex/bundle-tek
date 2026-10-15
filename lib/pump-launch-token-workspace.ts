import type { PumpGroupView } from './pump-launch-group-client';
import type { ImportedTokenProject } from './imported-token-project';
import { importedTradeSettings } from './imported-token-project';
import { PUMP_TOKEN_2022 } from './pump-launch-config';

export type PumpLaunchTokenWorkspace = {
  format: 'pump-launch-token-workspace-v1';
  reviewId: string;
  contextSha256: string;
  signedGroupSha256: string;
  mint: string;
  project: ImportedTokenProject;
  created: boolean;
  signingAllowed: false;
  executionAllowed: false;
  reservationsChanged: false;
};
export function pumpLaunchWorkspaceReady(group: PumpGroupView) {
  return (
    group.state === 'finalized' &&
    !!group.signedEvidence &&
    group.receipt?.format === 'pump-launch-group-broadcast-terminal-v1' &&
    group.receipt.kind === 'finalized' &&
    group.receipt.signedGroupSha256 === group.signedEvidence.signedGroupSha256
  );
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function parsePumpLaunchTokenWorkspace(
  value: unknown,
  group: PumpGroupView,
): PumpLaunchTokenWorkspace {
  const fail = (): never => {
    throw new Error(
      'Token workspace response differs from this finalized launch. Reload its saved history.',
    );
  };
  if (
    !record(value) ||
    !pumpLaunchWorkspaceReady(group) ||
    value.format !== 'pump-launch-token-workspace-v1' ||
    value.reviewId !== group.review.id ||
    value.contextSha256 !== group.review.contextSha256 ||
    value.signedGroupSha256 !== group.signedEvidence?.signedGroupSha256 ||
    value.mint !== group.review.input.create.mint ||
    typeof value.created !== 'boolean' ||
    value.signingAllowed !== false ||
    value.executionAllowed !== false ||
    value.reservationsChanged !== false ||
    !record(value.project)
  )
    return fail();
  const p = value.project;
  if (
    !uuid(p.id) ||
    !Number.isSafeInteger(p.revision) ||
    Number(p.revision) < 1 ||
    Number(p.revision) > 1000000000 ||
    typeof p.archived !== 'boolean' ||
    (value.created && p.archived) ||
    typeof p.updatedAt !== 'string' ||
    p.updatedAt.length > 32 ||
    !Number.isFinite(Date.parse(p.updatedAt)) ||
    !record(p.document) ||
    p.document.format !== 'imported-token-project-v1' ||
    p.document.executionAllowed !== false ||
    !record(p.document.token)
  )
    return fail();
  const t = p.document.token;
  if (
    t.chain !== 'Solana' ||
    t.address !== value.mint ||
    t.decimals !== 6 ||
    (t.tokenProgram !== undefined && t.tokenProgram !== PUMP_TOKEN_2022) ||
    typeof t.name !== 'string' ||
    !t.name.trim() ||
    t.name.length > 256 ||
    typeof t.symbol !== 'string' ||
    !t.symbol.trim() ||
    t.symbol.length > 64 ||
    typeof t.totalSupplyRaw !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(t.totalSupplyRaw) ||
    BigInt(t.totalSupplyRaw) > (1n << 64n) - 1n ||
    typeof t.observedAt !== 'string' ||
    t.observedAt.length > 32 ||
    !Number.isFinite(Date.parse(t.observedAt)) ||
    typeof t.source !== 'string' ||
    !t.source ||
    t.source.length > 253
  )
    return fail();
  if (p.document.tradeSettings !== undefined)
    importedTradeSettings(
      p.document.tradeSettings,
      t as ImportedTokenProject['document']['token'],
    );
  return value as PumpLaunchTokenWorkspace;
}
