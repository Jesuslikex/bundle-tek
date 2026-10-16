import { walletAddress } from './wallet-workspace';
import type { CounterPlan } from './counter-trade-store';
import type {
  CounterPreviewRequest,
  previewOwnedCounterBuy,
} from './counter-owned-preview';
export type CounterPreviewView = Awaited<
  ReturnType<typeof previewOwnedCounterBuy>
>;
export type CounterPreviewWallet = {
  address: string;
  revision: number;
  label: string;
};
const uint = (value: unknown, positive = false) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n ||
    (positive && value === '0')
  )
    throw Error('Counter preview amounts are invalid.');
  return BigInt(value);
};
export function counterPreviewWallets(
  value: unknown,
  plan: CounterPlan,
): CounterPreviewWallet[] {
  const v = value as { wallets?: unknown[]; proofs?: unknown[] };
  if (
    !Array.isArray(v?.wallets) ||
    v.wallets.length > 500 ||
    !Array.isArray(v.proofs) ||
    v.proofs.length > 500
  )
    throw Error('Verified wallet list is unavailable.');
  const proofs = new Set<string>();
  for (const row of v.proofs) {
    const p = row as {
      chain?: unknown;
      address?: unknown;
      verifiedAt?: unknown;
    };
    if (p?.chain !== 'Solana') continue;
    const address = walletAddress(p.address, 'Solana');
    if (
      proofs.has(address) ||
      typeof p.verifiedAt !== 'string' ||
      !Number.isFinite(Date.parse(p.verifiedAt)) ||
      Date.parse(p.verifiedAt) > Date.now() + 1000
    )
      throw Error('Wallet proof metadata is invalid.');
    if (!plan.rules.ignoredWallets.includes(address))
      throw Error(
        'Verified wallet exclusions changed. Review a new Counter plan before previewing.',
      );
    proofs.add(address);
  }
  const seen = new Set<string>(),
    wallets: CounterPreviewWallet[] = [];
  for (const row of v.wallets) {
    const w = row as {
      chain?: unknown;
      address?: unknown;
      archived?: unknown;
      revision?: unknown;
      role?: unknown;
      label?: unknown;
    };
    if (w?.chain !== 'Solana') continue;
    const address = walletAddress(w.address, 'Solana');
    if (
      seen.has(address) ||
      typeof w.archived !== 'boolean' ||
      !Number.isSafeInteger(w.revision) ||
      Number(w.revision) < 1 ||
      typeof w.label !== 'string' ||
      w.label.length > 80 ||
      typeof w.role !== 'string' ||
      !['Recipient', 'Deployer', 'Funder'].includes(w.role)
    )
      throw Error('Saved wallet metadata is invalid.');
    seen.add(address);
    if (!w.archived && proofs.has(address))
      wallets.push({ address, revision: Number(w.revision), label: w.label });
  }
  return wallets;
}
export function counterPreviewView(
  value: unknown,
  plan: CounterPlan,
  request: CounterPreviewRequest,
  now = Date.now(),
): CounterPreviewView {
  const p = (value as { preview?: CounterPreviewView })?.preview,
    decision = plan.ledger.decisions.find(
      (d) => d.identity === request.decisionIdentity,
    );
  if (
    !p ||
    p.format !== 'owned-counter-buy-preview-v1' ||
    request.projectId !== plan.projectId ||
    request.planId !== plan.id ||
    request.planRevision !== plan.revision ||
    request.projectRevision !== plan.ledger.scope.revision ||
    plan.state !== 'active' ||
    plan.rules.responseSide !== 'Buy' ||
    decision?.outcome !== 'proposal' ||
    decision.proposalTokenRaw === null ||
    p.mint !== plan.ledger.scope.mint ||
    p.tokenDecimals !== plan.ledger.scope.decimals ||
    p.outputTargetRaw !== decision.proposalTokenRaw ||
    !/^[a-f0-9]{64}$/.test(p.packetSha256) ||
    p.ownershipContextRechecked !== true ||
    p.grossSettlementReviewed !== true ||
    p.sourceRevalidated !== true ||
    p.programCodeAttested !== false ||
    p.reservationCreated !== false ||
    p.approvalAllowed !== false ||
    p.signingAllowed !== false ||
    p.executionAllowed !== false ||
    'transaction' in p
  )
    throw Error(
      'Counter simulation differs from the selected read-only proposal.',
    );
  for (const key of Object.keys(request) as (keyof CounterPreviewRequest)[])
    if (p[key] !== request[key])
      throw Error(
        'Counter simulation context changed. Request a fresh preview.',
      );
  walletAddress(p.wallet, 'Solana');
  const required = uint(p.requiredSolInputRaw, true),
    maximum = uint(p.maximumQuoteInputRaw, true),
    actual = uint(p.actualSimulatedInputRaw, true),
    budget = uint(request.maximumSolInputRaw, true);
  uint(p.outputTargetRaw, true);
  if (
    maximum < required ||
    maximum > budget ||
    maximum > (required * 10050n + 9999n) / 10000n ||
    actual > maximum ||
    uint(p.networkFeeLamports) > uint(request.maximumFeeAndRentRaw)
  )
    throw Error('Counter simulation exceeds the selected limits.');
  const observed = Date.parse(p.observedAt),
    expires = Date.parse(p.expiresAt),
    sourceChecked = Date.parse(p.sourceRecheckedAt),
    sourceExpires = Date.parse(p.sourceValidUntil);
  const end = plan.ledger.decisions.findIndex(
    (d) => d.identity === request.decisionIdentity,
  );
  let start = end;
  while (start > 0 && plan.ledger.decisions[start - 1].outcome !== 'proposal')
    start--;
  const sourceCount = plan.ledger.decisions
    .slice(start, end + 1)
    .filter((d) => uint(d.contributionTokenRaw) > 0n).length;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed > now + 1000 ||
    now - observed > 30000 ||
    expires <= now ||
    expires <= observed ||
    expires - observed > 30000 ||
    !Number.isFinite(sourceChecked) ||
    !Number.isFinite(sourceExpires) ||
    sourceChecked < observed - 1000 ||
    sourceChecked > now + 1000 ||
    now - sourceChecked > 30000 ||
    sourceExpires < expires ||
    sourceExpires > sourceChecked + 301000 ||
    !Number.isSafeInteger(p.sourceTradeCount) ||
    p.sourceTradeCount < 1 ||
    p.sourceTradeCount !== sourceCount
  )
    throw Error('Counter simulation expired. Request a fresh preview.');
  return p;
}
