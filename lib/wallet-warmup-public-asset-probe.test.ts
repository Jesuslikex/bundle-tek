import { expect, it, vi } from 'vitest';
import { warmupPublicAssetReviewFixture } from '../test/warmup-public-asset-review-fixture';
import {
  createWarmupAssetProbeFetch,
  WARMUP_ASSET_PROBE_ACCOUNTS,
  WARMUP_ASSET_PROBE_MINT,
} from '../scripts/warmup-asset-probe-policy.mjs';
import { inspectWarmupExecutionAssets } from './wallet-warmup-execution-assets';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { env } from '@/lib/server-env';
import { pairRentAccount } from '../test/pair-rent-fixture';
const endpoint =
  'https://rpc.example.invalid/private-key?api-key=fixture-secret';
const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function mint(decimals: number) {
  const b = new Uint8Array(82);
  b[44] = decimals;
  b[45] = 1;
  return {
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    executable: false,
    data: [wire(b), 'base64'],
  };
}
it.each([0, 1])(
  'runs the real reader and keyless full-schema public fixture with Clock offset %s',
  async (offset) => {
    const f = await warmupPublicAssetReviewFixture();
    env.SOLANA_INDEXER_RPC_URL = endpoint;
    let reads = 0;
    const raw = vi.fn<typeof fetch>(async (_input, init) => {
      const req = JSON.parse(init!.body as string);
      let result: unknown;
      if (req.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (req.method === 'getSlot') result = 100;
      else {
        expect(req.params[0]).toEqual(WARMUP_ASSET_PROBE_ACCOUNTS);
        reads++;
        const slot = 100 + reads;
        const b = new Uint8Array(40),
          view = new DataView(b.buffer);
        view.setBigUint64(0, BigInt(slot + offset), true);
        view.setBigInt64(32, BigInt(Math.floor(Date.now() / 1000)), true);
        result = {
          context: { slot },
          value: [
            mint(9),
            mint(6),
            {
              owner: 'Sysvar1111111111111111111111111111111111111',
              executable: false,
              data: [wire(b), 'base64'],
            },
            pairRentAccount(3480n, 2),
          ],
        };
      }
      return Response.json({ jsonrpc: '2.0', id: req.id, result });
    });
    const guarded = createWarmupAssetProbeFetch(endpoint, raw);
    try {
      const work = inspectWarmupExecutionAssets(
        f.db,
        f.owner,
        f.input,
        new AbortController().signal,
        { fetcher: guarded.fetch },
      );
      if (offset) {
        await expect(work).rejects.toThrow('Current warmup asset evidence');
        expect(raw).toHaveBeenCalledTimes(3);
        expect(guarded.trace.at(-1)).toMatchObject({
          reportedClockOffset: '1',
        });
      } else {
        const r = await work;
        expect(r.evidence.tokenAccountRents[1].address).toBe(
          WARMUP_ASSET_PROBE_MINT,
        );
        expect(r.evidence.executionAllowed).toBe(false);
        expect(() => JSON.stringify(r)).not.toThrow();
        expect(JSON.parse(JSON.stringify(r)).evidence).toEqual(r.evidence);
        expect(raw).toHaveBeenCalledTimes(4);
      }
      expect(JSON.stringify(guarded.trace)).not.toMatch(
        /private-key|fixture-secret|api-key/,
      );
    } finally {
      f.dispose();
      delete env.SOLANA_INDEXER_RPC_URL;
    }
  },
);
