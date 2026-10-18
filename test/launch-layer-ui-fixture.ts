import { launchLayerFixture } from './launch-layer-fixture';
import {
  layerDisplay,
  type LayerPlanningContext,
  type LayerDraft,
} from '../lib/launch-layer-client';
export function layerUiFixture() {
  const f = launchLayerFixture();
  const context: LayerPlanningContext = {
    projectId: f.selection.projectId,
    projectUpdatedAt: f.updatedAt,
    document: f.document,
    target: f.selection.target,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
    workspace: {
      folders: [],
      wallets: Array.from({ length: 8 }, (_, i) => ({
        chain: 'Solana',
        address: f.address(i + 1),
        folderId: '',
        folderIds: [],
        label: `Wallet ${i + 1}`,
        role: 'Recipient',
        revision: 2,
        archived: false,
        updatedAt: f.updatedAt,
      })),
    },
  };
  const rows: LayerDraft['rows'] = [];
  for (const role of [
    'funder',
    'developer',
    'front',
    'back',
    'temporary',
    'holders',
  ] as const) {
    const value = f.layers.roles[role];
    const members = Array.isArray(value) ? value : value ? [value] : [];
    for (const m of members)
      rows.push({
        id: `${role}-${rows.length}`,
        role,
        wallet: m.wallet,
        buy: layerDisplay(m.maximumBuyQuoteRaw, 9),
        fee: layerDisplay(m.maximumNetworkFeeLamports, 9),
        rent: layerDisplay(m.maximumAccountRentLamports, 9),
        reserve: layerDisplay(m.retainedNativeReserveLamports, 9),
      });
  }
  return {
    ...f,
    context,
    draft: {
      rows,
      fundingDelaySeconds: '1',
      frontToBackDelayMs: '700',
      backToTemporaryDelayMs: '500',
    } satisfies LayerDraft,
  };
}
