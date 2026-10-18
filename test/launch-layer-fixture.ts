import bs58 from 'bs58';
import { DEFAULT_LAUNCH_PLAN } from '../lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '../lib/workspace-project';
import type { LaunchLayerRequest } from '../lib/launch-layer-terms';
export function launchLayerFixture() {
  const address = (n: number) =>
    bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 7)));
  const member = (n: number, buy: string) => ({
    wallet: {
      address: address(n),
      revision: 2,
      folderRevision: 0,
      root: true as const,
    },
    maximumBuyQuoteRaw: buy,
    maximumNetworkFeeLamports: '5000',
    maximumAccountRentLamports: '2000000',
    retainedNativeReserveLamports: '100000',
  });
  const layers: LaunchLayerRequest = {
    roles: {
      funder: member(1, '0'),
      developer: member(2, '100'),
      front: [member(3, '1000')],
      back: [member(4, '300')],
      temporary: [member(5, '0')],
      holders: [member(6, '0'), member(7, '0')],
    },
    delays: {
      fundingDelaySeconds: 1,
      frontToBackDelayMs: 700,
      backToTemporaryDelayMs: 500,
    },
  };
  const document = validateProjectDocument({
    plan: { ...DEFAULT_LAUNCH_PLAN, holderCount: 2 },
    identity: structuredClone(EMPTY_IDENTITY),
    options: {
      ...structuredClone(DEFAULT_VENUE_OPTIONS),
      wallets: {
        chain: 'Solana',
        deployer: layers.roles.developer!.wallet,
        recipients: layers.roles.holders.map((m) => m.wallet),
      },
    },
  });
  const updatedAt = '2026-10-18T03:00:00.123Z';
  const selection = {
    projectId: 'layer-source',
    projectUpdatedAt: updatedAt,
    target: { kind: 'new' as const, mint: address(99) },
  };
  return {
    address,
    document,
    updatedAt,
    layers,
    selection,
    input: { ...selection, layers },
    now: () => Date.parse('2026-10-18T03:01:00.000Z'),
  };
}
