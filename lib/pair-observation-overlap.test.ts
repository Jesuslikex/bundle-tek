import { afterEach, expect, it } from 'vitest';
import { pairWalletFixture } from '../test/pair-wallet-fixture';
import { quoteOwnedImportedPair } from './imported-pair-quote-service';
import { preflightOwnedImportedPairWallet } from './imported-pair-wallet-preflight';
let fixture: Awaited<ReturnType<typeof pairWalletFixture>> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['quote', 'wallet'] as const)(
  'overlaps the final %s observation with a fresh network check but joins both before publishing',
  async (stage) => {
    const f = (fixture = await pairWalletFixture()),
      held = latch(),
      network = latch(),
      release = latch();
    const original = f.rpc.getMockImplementation()!;
    let mintReads = 0,
      walletReads = 0,
      genesisReads = 0,
      published = false;
    f.rpc.mockImplementation(async (method, params) => {
      if (method === 'getMultipleAccounts') {
        const keys = params[0] as string[];
        if (keys.includes(f.wallet)) walletReads++;
        else mintReads++;
        if (stage === 'quote' ? mintReads === 2 : walletReads === 2) {
          held.resolve();
          await release.promise;
        }
      }
      if (
        method === 'getGenesisHash' &&
        ++genesisReads === (stage === 'quote' ? 2 : 3)
      )
        network.resolve();
      return original(method, params);
    });
    const work = (
      stage === 'quote'
        ? quoteOwnedImportedPair(
            f.db,
            'alice',
            f.request,
            new AbortController().signal,
            f.dependencies,
          )
        : preflightOwnedImportedPairWallet(
            f.db,
            'alice',
            f.walletRequest,
            new AbortController().signal,
            f.dependencies,
          )
    ).then((result) => {
      published = true;
      return result;
    });
    try {
      await held.promise;
      await network.promise;
      expect(published).toBe(false);
    } finally {
      release.resolve();
    }
    expect((await work).executionAllowed).toBe(false);
  },
);
