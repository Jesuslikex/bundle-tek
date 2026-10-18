import type { LaunchChain } from './launch-plan';
import { walletAddress, type WalletWorkspace } from './wallet-workspace';
import { readWorkspaceResponse } from './workspace-response';

const unavailable =
  'Could not confirm the saved address. Your encrypted wallet is safe. Retry saving its public address.';
const signIn = 'Sign in again, then retry saving this wallet’s public address.';

// Each stage includes response parsing. Racing the deadline also releases the UI
// when a transport ignores AbortSignal; late responses cannot publish state.
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new Error(unavailable));
    };
    timer = setTimeout(cancel, 5_000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  try {
    return await Promise.race([deadline, work(controller.signal)]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function saveWalletPublicAddresses({
  chain,
  addresses,
  folderId,
  signal,
}: {
  chain: LaunchChain;
  addresses: string[];
  folderId: string;
  signal?: AbortSignal;
}): Promise<WalletWorkspace> {
  const requested = [
    ...new Set(addresses.map((address) => walletAddress(address, chain))),
  ];
  if (!requested.length || requested.length > 100)
    throw new Error('Choose 1 to 100 wallet addresses.');
  async function read() {
    return bounded(async (requestSignal) => {
      const response = await fetch('/api/wallet-workspace', {
        cache: 'no-store',
        signal: requestSignal,
      });
      const data = await readWorkspaceResponse(response, unavailable, signIn);
      if (!Array.isArray(data.wallets) || !Array.isArray(data.folders))
        throw new Error(unavailable);
      return data as WalletWorkspace;
    }, signal);
  }
  function confirmed(data: WalletWorkspace) {
    return requested.every((address) =>
      data.wallets.some(
        (wallet) =>
          wallet?.chain === chain &&
          wallet.address === address &&
          wallet.archived === false &&
          Number.isSafeInteger(wallet.revision) &&
          wallet.revision > 0,
      ),
    );
  }
  const before = await read();
  if (confirmed(before)) return before;
  if (
    before.wallets.some(
      (wallet) =>
        wallet?.chain === chain &&
        requested.includes(wallet.address) &&
        wallet.archived,
    )
  )
    throw new Error(
      'This public address is archived. Restore it from Archived wallets, then continue to warmup.',
    );
  if (signal?.aborted) throw new Error(unavailable);
  let denied = false;
  try {
    await bounded(async (requestSignal) => {
      const response = await fetch('/api/wallet-workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: requestSignal,
        body: JSON.stringify({
          chain,
          action: 'wallet.add',
          folderId,
          wallets: requested.map((address) => ({
            address,
            label: '',
            role: 'Recipient',
          })),
        }),
      });
      denied = response.status === 401;
      if (denied) throw new Error(signIn);
      // A duplicate-only response can follow an earlier successful request.
      // Only a fresh owned workspace can establish success.
    }, signal);
  } catch {
    if (denied) throw new Error(signIn);
  }
  if (signal?.aborted) throw new Error(unavailable);
  const after = await read();
  if (!confirmed(after)) throw new Error(unavailable);
  return after;
}
