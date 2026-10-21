import { z } from 'zod';
import { parseLaunchLayerSetup } from './launch-layer-setup';
import {
  createLaunchLayerTerms,
  parseLaunchLayerEnvelope,
  type LaunchLayerContext,
  type LaunchLayerEnvelope,
  type LaunchLayerRequest,
} from './launch-layer-terms';
import { quoteCatalog } from './quote-catalog';
import { validateProjectDocument } from './workspace-project';
import type { readLaunchLayerContext } from './launch-layer-service';

export type LayerPlanningContext = Awaited<
  ReturnType<typeof readLaunchLayerContext>
>;
export type LayerSelection = {
  projectId: string;
  projectUpdatedAt: string;
  target:
    | { kind: 'new'; mint: string }
    | { kind: 'imported'; projectId: string; revision: number; mint: string };
};
/** Imported mint is a local comparison value, never caller authority for resolution. */
export function layerSelectionRequest(selection: LayerSelection) {
  return {
    projectId: selection.projectId,
    projectUpdatedAt: selection.projectUpdatedAt,
    target:
      selection.target.kind === 'new'
        ? { kind: 'new' as const, mint: selection.target.mint }
        : {
            kind: 'imported' as const,
            projectId: selection.target.projectId,
            revision: selection.target.revision,
          },
  };
}
export type LayerRole =
  | 'funder'
  | 'developer'
  | 'front'
  | 'back'
  | 'temporary'
  | 'holders';
export type LayerRow = {
  id: string;
  role: LayerRole;
  wallet?: LaunchLayerRequest['roles']['funder']['wallet'];
  buy: string;
  fee: string;
  rent: string;
  reserve: string;
};
export type LayerDraft = {
  rows: LayerRow[];
  fundingDelaySeconds: string;
  frontToBackDelayMs: string;
  backToTemporaryDelayMs: string;
};
export function parseSavedLayer(value: unknown, projectId: string) {
  try {
    const record = z
      .object({
        id: z.uuid(),
        projectId: z.literal(projectId),
        projectUpdatedAt: z.iso.datetime(),
        createdAt: z.iso.datetime(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        current: z.boolean(),
        importedTarget: z
          .object({
            projectId: z.string().min(1).max(200),
            revision: z.number().int().positive(),
          })
          .strict()
          .optional(),
        planningOnly: z.literal(true),
        fundingAllowed: z.literal(false),
        signingAllowed: z.literal(false),
        executionAllowed: z.literal(false),
        envelope: z.unknown(),
        setup: z.unknown().optional(),
      })
      .parse(value);
    const envelope = parseLaunchLayerEnvelope(record.envelope);
    if (
      (envelope.terms.binding.target.kind === 'imported') !==
      Boolean(record.importedTarget)
    )
      throw new Error('Saved imported identity is unavailable.');
    const setup =
      record.setup === undefined
        ? undefined
        : parseLaunchLayerSetup(record.setup, envelope, {
            projectId: record.projectId,
            projectUpdatedAt: record.projectUpdatedAt,
            snapshotSha256: record.sha256,
          });
    return { ...record, envelope, setup };
  } catch {
    throw new Error(
      'Saved planning data could not be confirmed. Reload layer history before retrying.',
    );
  }
}
const uint = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const wallet = z.object({
  chain: z.literal('Solana'),
  address: z.string().min(32).max(44),
  revision: uint.positive(),
  archived: z.boolean(),
  label: z.string().max(200),
  folderId: z.string(),
  folderIds: z.array(z.string()).max(100).optional(),
  role: z.enum(['Recipient', 'Deployer', 'Funder']),
  updatedAt: z.string(),
});
const folder = z.object({
  id: z.string(),
  chain: z.literal('Solana'),
  name: z.string(),
  revision: uint.positive(),
  archived: z.boolean(),
  updatedAt: z.string(),
});
export function parseLayerContext(
  value: unknown,
  selection: LayerSelection,
): LayerPlanningContext {
  const parsed = z
    .object({
      projectId: z.literal(selection.projectId),
      projectUpdatedAt: z.literal(selection.projectUpdatedAt),
      document: z.unknown(),
      workspace: z.object({
        wallets: z.array(wallet).max(500),
        folders: z.array(folder).max(100),
      }),
      target: z.object({
        kind: z.literal(selection.target.kind),
        mint: z.literal(selection.target.mint),
      }),
      importedTarget:
        selection.target.kind === 'imported'
          ? z
              .object({
                projectId: z.literal(selection.target.projectId),
                revision: z.literal(selection.target.revision),
              })
              .strict()
          : z.undefined().optional(),
      fundingAllowed: z.literal(false),
      signingAllowed: z.literal(false),
      executionAllowed: z.literal(false),
    })
    .parse(value);
  return { ...parsed, document: validateProjectDocument(parsed.document) };
}
export function savedLayerMatchesSelection(
  saved: ReturnType<typeof parseSavedLayer>,
  selection: LayerSelection,
) {
  const target = saved.envelope.terms.binding.target;
  return (
    saved.projectId === selection.projectId &&
    saved.projectUpdatedAt === selection.projectUpdatedAt &&
    target.kind === selection.target.kind &&
    target.mint === selection.target.mint &&
    (selection.target.kind === 'new' ||
      (saved.importedTarget?.projectId === selection.target.projectId &&
        saved.importedTarget?.revision === selection.target.revision))
  );
}
export function layerQuote(context: LayerPlanningContext) {
  const plan = context.document.plan;
  const matches = quoteCatalog(plan.chain, plan.launchpad).assets.filter(
    (q) =>
      q.symbol === plan.currency &&
      (!plan.quoteAddress || q.address === plan.quoteAddress),
  );
  if (matches.length !== 1)
    throw new Error('Save one exact quote asset in the launch project first.');
  return matches[0];
}
export function newLayerRow(
  role: LayerRole,
  ref?: LayerRow['wallet'],
): LayerRow {
  return {
    id: crypto.randomUUID(),
    role,
    wallet: ref,
    buy: ['funder', 'temporary'].includes(role) ? '0' : '',
    fee: '',
    rent: '',
    reserve: '',
  };
}
export function initialLayerDraft(context: LayerPlanningContext): LayerDraft {
  const wallets = context.document.options.wallets;
  if (
    !wallets ||
    wallets.chain !== 'Solana' ||
    (context.target.kind === 'new' && !wallets.deployer) ||
    wallets.recipients.length !== context.document.plan.holderCount
  )
    throw new Error(
      'Save the developer and complete ordered holder selection in launch settings first.',
    );
  if (
    context.document.plan.chain !== 'Solana' ||
    context.document.plan.mode !== 'Block-0'
  )
    throw new Error('Layer planning requires a saved Solana Block-0 plan.');
  if (context.target.kind === 'imported' && !context.document.plan.scheduled)
    throw new Error('Imported layer planning requires a saved scheduled plan.');
  return {
    rows: [
      newLayerRow('funder'),
      ...(context.target.kind === 'new'
        ? [newLayerRow('developer', wallets.deployer)]
        : []),
      newLayerRow('front'),
      ...wallets.recipients.map((ref) => newLayerRow('holders', ref)),
    ],
    fundingDelaySeconds: '0',
    frontToBackDelayMs: '0',
    backToTemporaryDelayMs: '0',
  };
}
export function layerAmount(value: string, decimals: number) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/.test(value)
  )
    throw new Error(
      'Enter each ceiling as an exact non-negative amount, including 0 where none is intended.',
    );
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error('Amount exceeds the selected asset precision.');
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw > (1n << 64n) - 1n)
    throw new Error('Amount exceeds the Solana limit.');
  return raw.toString();
}
export function layerDisplay(raw: string, decimals: number) {
  const padded = raw.padStart(decimals + 1, '0');
  if (!decimals) return raw;
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export function layerRequest(
  draft: LayerDraft,
  context: LayerPlanningContext,
): LaunchLayerRequest {
  const quote = layerQuote(context);
  const grouped = (role: LayerRole) =>
    draft.rows
      .filter((r) => r.role === role)
      .map((row) => {
        if (!row.wallet) throw new Error(`Choose a ${role} wallet.`);
        return {
          wallet: row.wallet,
          maximumBuyQuoteRaw: layerAmount(row.buy, quote.decimals),
          maximumNetworkFeeLamports: layerAmount(row.fee, 9),
          maximumAccountRentLamports: layerAmount(row.rent, 9),
          retainedNativeReserveLamports: layerAmount(row.reserve, 9),
        };
      });
  const funders = grouped('funder'),
    developers = grouped('developer');
  if (
    funders.length !== 1 ||
    developers.length !== (context.target.kind === 'new' ? 1 : 0)
  )
    throw new Error(
      context.target.kind === 'new'
        ? 'Use one funder and the saved developer.'
        : 'Use one funder and no developer for an imported token.',
    );
  const delay = (text: string, max: number) => {
    if (!/^(0|[1-9]\d{0,5})$/.test(text) || Number(text) > max)
      throw new Error('Enter a whole delay within the displayed limit.');
    return Number(text);
  };
  return {
    roles: {
      funder: funders[0],
      ...(developers.length ? { developer: developers[0] } : {}),
      front: grouped('front'),
      back: grouped('back'),
      temporary: grouped('temporary'),
      holders: grouped('holders'),
    },
    delays: {
      fundingDelaySeconds: delay(draft.fundingDelaySeconds, 86400),
      frontToBackDelayMs: delay(draft.frontToBackDelayMs, 10000),
      backToTemporaryDelayMs: delay(draft.backToTemporaryDelayMs, 10000),
    },
  };
}
export async function reviewLayerDraft(
  draft: LayerDraft,
  context: LayerPlanningContext,
): Promise<LaunchLayerEnvelope> {
  const ownedContext: LaunchLayerContext = {
    ownerId: 'local-planning-preview',
    savedPlan: {
      ...context.document.plan,
      updatedAt: context.projectUpdatedAt,
    },
    workspace: context.workspace,
    target: context.target,
  };
  return createLaunchLayerTerms(layerRequest(draft, context), ownedContext);
}
export async function reopenLayerDraft(
  envelope: LaunchLayerEnvelope,
  context: LayerPlanningContext,
  savedImportedTarget?: { projectId: string; revision: number },
): Promise<LayerDraft> {
  const { terms } = envelope;
  const binding = terms.binding;
  const assigned = context.document.options.wallets;
  const key = (ref: LayerRow['wallet']) =>
    ref
      ? JSON.stringify([
          ref.address,
          ref.revision,
          ref.folderRevision,
          ref.folderId ?? null,
          ref.root === true,
        ])
      : null;
  if (
    !assigned ||
    (context.target.kind === 'imported' &&
      (!savedImportedTarget ||
        savedImportedTarget.projectId !== context.importedTarget?.projectId ||
        savedImportedTarget.revision !== context.importedTarget?.revision)) ||
    binding.savedPlanUpdatedAt !== context.projectUpdatedAt ||
    binding.savedPlanJson !== JSON.stringify(context.document.plan) ||
    binding.target.kind !== context.target.kind ||
    binding.target.mint !== context.target.mint ||
    key(terms.roles.developer?.wallet) !==
      key(context.target.kind === 'new' ? assigned.deployer : undefined) ||
    JSON.stringify(terms.roles.holders.map((m) => key(m.wallet))) !==
      JSON.stringify(assigned.recipients.map(key))
  )
    throw new Error(
      'Saved roles belong to a different source revision, mint or holder selection. Reload current context and create a new draft.',
    );
  const rows: LayerRow[] = [];
  for (const role of [
    'funder',
    'developer',
    'front',
    'back',
    'temporary',
    'holders',
  ] as const) {
    const value = terms.roles[role];
    for (const member of Array.isArray(value) ? value : value ? [value] : [])
      rows.push({
        id: crypto.randomUUID(),
        role,
        wallet: structuredClone(member.wallet),
        buy: layerDisplay(member.maximumBuyQuoteRaw, terms.quote.decimals),
        fee: layerDisplay(member.maximumNetworkFeeLamports, 9),
        rent: layerDisplay(member.maximumAccountRentLamports, 9),
        reserve: layerDisplay(member.retainedNativeReserveLamports, 9),
      });
  }
  const draft = {
    rows,
    fundingDelaySeconds: String(terms.delays.fundingDelaySeconds),
    frontToBackDelayMs: String(terms.delays.frontToBackDelayMs),
    backToTemporaryDelayMs: String(terms.delays.backToTemporaryDelayMs),
  };
  const rebuilt = await reviewLayerDraft(draft, context);
  if (
    JSON.stringify(rebuilt.terms.quote) !== JSON.stringify(terms.quote) ||
    JSON.stringify(rebuilt.terms.totals) !== JSON.stringify(terms.totals)
  )
    throw new Error(
      'Saved quote units or totals do not match current planning.',
    );
  return draft;
}
