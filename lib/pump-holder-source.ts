import type { buildPumpCreateHolderMessage } from './pump-holder-message';
import type { PumpRpcAccount } from './pump-launch-simulation';
import { pumpBuybackSourceHash } from './pump-buyback-source';

type Packet = Awaited<ReturnType<typeof buildPumpCreateHolderMessage>>;

/** The complete holder packet supplies the only allowed shared fee accounts. */
export function pumpHolderSourceHash(
  packet: Pick<Packet, 'buyerAccounts' | 'quoteMint' | 'quote'>,
  address: string,
  observed: PumpRpcAccount,
) {
  return pumpBuybackSourceHash(packet, address, observed);
}
