import { layerUiFixture } from './launch-layer-ui-fixture';
import { createLaunchLayerTerms } from '../lib/launch-layer-terms';
import {
  layerRoleMembers,
  savedLayerSolObservation,
  type LayerNativeEvidence,
} from '../lib/launch-layer-native-coverage';
import { formatNativeBalance } from '../lib/wallet-balance-format';
import { quoteCatalog } from '../lib/quote-catalog';
export async function layerNativeFixture(stock = false) {
  const f = layerUiFixture();
  if (stock) {
    const asset = quoteCatalog('Solana', 'StonkFun').assets.find(
      (a) => a.symbol === 'TSLAX',
    )!;
    f.document.plan.launchpad = 'StonkFun';
    f.document.plan.currency = asset.symbol;
    f.document.plan.quoteAddress = asset.address;
    f.layers.roles.back = [];
    f.layers.roles.temporary = [];
    f.layers.delays.frontToBackDelayMs = 0;
    f.layers.delays.backToTemporaryDelayMs = 0;
    f.layers.roles.front[0].maximumBuyQuoteRaw = '9007199254740993';
  }
  const envelope = await createLaunchLayerTerms(f.layers, {
    ...f.context,
    ownerId: 'alice',
    savedPlan: { ...f.document.plan, updatedAt: f.updatedAt },
  });
  const plan = {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: f.selection.projectId,
    sha256: 'a'.repeat(64),
    envelope,
    current: true,
  };
  const checkedAt = new Date(f.now()).toISOString();
  const document = (address: string, raw = '9007199254740993') => ({
    chain: 'Solana' as const,
    address,
    raw,
    amount: formatNativeBalance(raw, 9),
    currency: 'SOL',
    decimals: 9,
    blockNumber: 123,
    blockHash: null,
    observedAt: '2026-10-18T03:00:00.000Z',
    snapshotId: '00000000-0000-4000-8000-000000000002',
    source: 'rpc.example.test',
    commitment: 'confirmed',
  });
  const evidence: LayerNativeEvidence = {
    planId: plan.id,
    sha256: plan.sha256,
    termsSha256: envelope.sha256,
    checkedAt,
    rows: layerRoleMembers(envelope).map((row) => ({
      address: row.member.wallet.address,
      observation: savedLayerSolObservation(
        document(row.member.wallet.address),
        row.member.wallet.address,
        123,
        checkedAt,
      ),
      issue: null,
    })),
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  return { f, plan, evidence, document };
}
