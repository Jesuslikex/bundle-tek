import { layerNativeFixture } from './launch-layer-native-fixture';
import { createLaunchLayerTerms } from '../lib/launch-layer-terms';

export async function largeLayerReviewFixture(stock = false) {
  const { f } = await layerNativeFixture(stock);
  const template = f.layers.roles.front[0];
  f.layers.roles.front = Array.from({ length: stock ? 12 : 56 }, (_, index) => {
    const address = f.address(index + 10);
    f.context.workspace.wallets.push({
      ...f.context.workspace.wallets[0],
      address,
      label: `Front ${index + 1}`,
    });
    return { ...template, wallet: { ...template.wallet, address } };
  });
  return createLaunchLayerTerms(f.layers, {
    ...f.context,
    ownerId: 'alice',
    savedPlan: { ...f.document.plan, updatedAt: f.updatedAt },
  });
}
