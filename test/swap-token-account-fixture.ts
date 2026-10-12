import bs58 from 'bs58';
import { routeOrder, routeWallet } from './jupiter-route-fixture';
export function tokenAccountFixture(
  mint = routeOrder.inputMint,
  wallet = routeWallet,
  state = 1,
) {
  const bytes = new Uint8Array(165);
  bytes.set(bs58.decode(mint), 0);
  bytes.set(bs58.decode(wallet), 32);
  bytes[108] = state;
  return {
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    executable: false,
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
}
