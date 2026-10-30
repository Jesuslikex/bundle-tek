import { expect, it, vi } from 'vitest';
import { readJitoCpmmAssetEvidence } from './jito-cpmm-asset-evidence';
vi.mock('./jito-cpmm-unsigned-packet', () => ({
  inspectJitoCpmmUnsignedPacket: vi.fn(async () => ({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    transactionSha256: 'a'.repeat(64),
  })),
}));
const packet = {} as Parameters<typeof readJitoCpmmAssetEvidence>[0];
function reply(slot: number) {
  const mint = (decimals: number) => {
    const b = Buffer.alloc(82);
    b[44] = decimals;
    b[45] = 1;
    return {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      executable: false,
      lamports: '1461600',
      data: [b.toString('base64'), 'base64'],
    };
  };
  const rent = Buffer.alloc(17);
  rent.writeBigUInt64LE(3480n, 0);
  rent.writeDoubleLE(2, 8);
  rent[16] = 50;
  return {
    context: { slot: String(slot) },
    value: [
      mint(9),
      mint(6),
      {
        owner: 'Sysvar1111111111111111111111111111111111111',
        executable: false,
        lamports: '1',
        data: [rent.toString('base64'), 'base64'],
      },
    ],
  };
}
it('repeats mint/Rent reads at a monotonic floor and derives canonical rent without granting authority', async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce(reply(102))
    .mockResolvedValueOnce(reply(132));
  const result = await readJitoCpmmAssetEvidence(
    packet,
    100,
    rpc,
    new AbortController().signal,
  );
  expect(rpc.mock.calls[1][1][1].minContextSlot).toBe(102);
  expect(result.tokenAccountRentLamports).toBe('2039280');
  expect(result).toMatchObject({
    bankVerified: false,
    poolVerified: false,
    priceVerified: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it.each([99, 133])('refuses out-of-window slot %s', async (slot) => {
  const rpc = vi.fn().mockResolvedValue(reply(slot));
  await expect(
    readJitoCpmmAssetEvidence(packet, 100, rpc, new AbortController().signal),
  ).rejects.toThrow();
});
it('refuses a changed mint policy', async () => {
  const after = reply(101);
  const b = Buffer.from(after.value[1].data[0], 'base64');
  b[44] = 7;
  after.value[1].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmAssetEvidence(
      packet,
      100,
      vi.fn().mockResolvedValueOnce(reply(100)).mockResolvedValueOnce(after),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('refuses changed rent', async () => {
  const after = reply(101);
  const b = Buffer.from(after.value[2].data[0], 'base64');
  b[16] = 51;
  after.value[2].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmAssetEvidence(
      packet,
      100,
      vi.fn().mockResolvedValueOnce(reply(100)).mockResolvedValueOnce(after),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('does not call the provider after cancellation', async () => {
  const control = new AbortController();
  control.abort();
  const rpc = vi.fn();
  await expect(
    readJitoCpmmAssetEvidence(packet, 100, rpc, control.signal),
  ).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it.each([0, 1])('refuses an underfunded mint at position %s', async (i) => {
  const r = reply(100);
  Object.assign(r.value[i], { lamports: '1461599' });
  await expect(
    readJitoCpmmAssetEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow('rent coverage');
});
it('checks mint rent coverage again in the final read', async () => {
  const after = reply(101);
  Object.assign(after.value[1], { lamports: '1' });
  await expect(
    readJitoCpmmAssetEvidence(
      packet,
      100,
      vi.fn().mockResolvedValueOnce(reply(100)).mockResolvedValueOnce(after),
      new AbortController().signal,
    ),
  ).rejects.toThrow('rent coverage');
});
