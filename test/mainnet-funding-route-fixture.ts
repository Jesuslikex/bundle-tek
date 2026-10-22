import bs58 from 'bs58';
import { validateFunding, type SavedFunding } from '../lib/funding-plan';
import { fundingLegs, selectedFundingCapture } from '../lib/mainnet-funding';
import { createFundingRouteSource } from '../lib/mainnet-funding-route-history';
import {
  fundingLegPage,
  fundingLegRecord,
} from './mainnet-funding-leg-history-fixture';
import { formatNativeBalance } from '../lib/wallet-balance-format';

export async function fundingRouteFixture() {
  const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  const plan: SavedFunding = {
    id: 'saved-funding',
    revision: 1,
    archived: false,
    updatedAt: '2026-10-21T00:00:00.000Z',
    document: validateFunding({
      name: 'Synthetic route review',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Wallet',
      sourceLabel: '',
      funderAddress: address(1),
      startAt: '2026-10-20T00:00:00.000Z',
      delaySeconds: 30,
      recipients: [
        { address: address(3), amount: '0.01', proxies: [address(2)] },
        { address: address(4), amount: '0.02' },
      ],
    }),
  };
  let sequence = 0;
  const records = [];
  for (let item = 1; item <= plan.document.items.length; item++) {
    const legs = fundingLegs(plan.document, item);
    for (let n = 0; n < legs.length; n++) {
      const step = legs[n],
        leg = plan.document.items[item - 1].proxies ? n + 1 : undefined;
      const funding = await selectedFundingCapture(
        plan,
        {
          planId: plan.id,
          revision: 1,
          item,
          ...(leg === undefined ? {} : { leg }),
        },
        step,
      );
      records.push({
        ...fundingLegRecord(item, leg, ++sequence),
        ...step,
        funding,
        amount: formatNativeBalance(step.amountRaw, 9),
      });
    }
  }
  return {
    plan,
    source: await createFundingRouteSource(plan),
    page: fundingLegPage(records),
  };
}
