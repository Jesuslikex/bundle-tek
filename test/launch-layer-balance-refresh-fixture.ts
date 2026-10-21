import bs58 from 'bs58';
import { layerNativeFixture } from './launch-layer-native-fixture';
import { createLaunchLayerTerms } from '../lib/launch-layer-terms';
import {
  layerRoleMembers,
  savedLayerSolObservation,
  type LayerNativeEvidence,
} from '../lib/launch-layer-native-coverage';
import { formatNativeBalance } from '../lib/wallet-balance-format';

export async function layerBalanceRefreshFixture(count = 7, stock = false) {
  const base = await layerNativeFixture(stock),
    { f } = base;
  const address = (n: number) => {
    const bytes = new Uint8Array(32).fill(7);
    bytes[30] = n >> 8;
    bytes[31] = n & 255;
    return bs58.encode(bytes);
  };
  const members = (
    n: number,
    start: number,
    template: (typeof f.layers.roles.front)[number],
  ) =>
    Array.from({ length: n }, (_, index) => ({
      ...structuredClone(template),
      wallet: { ...template.wallet, address: address(start + index) },
    }));
  const remaining = count - 4,
    front = Math.min(200, remaining),
    back = Math.min(200, remaining - front),
    temporary = remaining - front - back;
  f.layers.roles.front = members(front, 1, f.layers.roles.front[0]);
  f.layers.roles.back = members(back, 201, f.layers.roles.front[0]);
  f.layers.roles.temporary = members(temporary, 401, {
    ...f.layers.roles.front[0],
    maximumBuyQuoteRaw: '0',
  });
  if (!back) f.layers.delays.frontToBackDelayMs = 0;
  if (!back || !temporary) f.layers.delays.backToTemporaryDelayMs = 0;
  const all = [
    f.layers.roles.funder,
    f.layers.roles.developer!,
    ...f.layers.roles.front,
    ...f.layers.roles.back,
    ...f.layers.roles.temporary,
    ...f.layers.roles.holders,
  ];
  f.context.workspace.wallets = all.map((row) => ({
    ...f.context.workspace.wallets[0],
    address: row.wallet.address,
    revision: row.wallet.revision,
  }));
  const envelope = await createLaunchLayerTerms(f.layers, {
    ...f.context,
    ownerId: 'alice',
    savedPlan: { ...f.document.plan, updatedAt: f.updatedAt },
  });
  const plan = { ...base.plan, envelope };
  const epoch = Date.parse('2026-10-21T20:00:00.000Z');
  const evidence: LayerNativeEvidence = {
    planId: plan.id,
    sha256: plan.sha256,
    termsSha256: envelope.sha256,
    checkedAt: new Date(epoch).toISOString(),
    rows: layerRoleMembers(envelope).map((row) => ({
      address: row.member.wallet.address,
      observation: null,
      issue: 'missing',
    })),
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  let sequence = 0;
  const refresh = async (addresses: string[]) => {
    sequence++;
    const meta = {
      chain: 'Solana' as const,
      currency: 'SOL',
      blockNumber: 123 + sequence,
      observedAt: new Date(epoch + sequence * 1000).toISOString(),
      snapshotId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      source: 'rpc.example.test',
      commitment: 'confirmed',
      blockHash: null,
    };
    const items = addresses.map((address) => ({
      ...meta,
      address,
      raw: '9007199254740993',
      amount: formatNativeBalance('9007199254740993', 9),
      decimals: 9,
    }));
    evidence.checkedAt = meta.observedAt;
    for (const item of items) {
      const row = evidence.rows.find((row) => row.address === item.address)!;
      row.observation = savedLayerSolObservation(
        item,
        item.address,
        meta.blockNumber,
        meta.observedAt,
      );
      row.issue = null;
    }
    return {
      ...meta,
      items,
      total: formatNativeBalance(
        String(9007199254740993n * BigInt(items.length)),
        9,
      ),
    };
  };
  return {
    f,
    plan,
    evidence,
    refresh,
    read: async () => structuredClone(evidence),
  };
}
