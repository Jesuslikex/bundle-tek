import { pumpAccountBytes, pumpRpcAccount } from './pump-launch-simulation';
const UNSUPPORTED_WRITABLE_OWNERS = new Set([
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
]);
/** Trading runtime profile only; apply to both observed and simulated writable state. */
export function assertPairRuntimeWritableAccount(raw: unknown) {
  const a = pumpRpcAccount(raw);
  if (
    a &&
    (a.executable ||
      UNSUPPORTED_WRITABLE_OWNERS.has(a.owner) ||
      (a.owner === '11111111111111111111111111111111' &&
        pumpAccountBytes(a).length))
  )
    throw Error(
      'Pair runtime exposes unsupported writable custody or executable state.',
    );
}
