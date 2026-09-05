import { it, expect, vi } from 'vitest';
import { observeReceipt } from './receipt';
import { sample } from './testing';
const hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const blockHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const unsigned = {
  chainId: 4663,
  from: sample.wallet,
  to: sample.wallet,
  value: '7',
  data: '0x1234',
  nonce: 8,
};
function client() {
  return {
    getChainId: vi.fn(async () => 4663),
    getTransaction: vi.fn(async () => ({
      chainId: 4663,
      from: unsigned.from,
      to: unsigned.to,
      value: 7n,
      input: '0x1234',
      nonce: 8,
      gas: 600000n,
      gasPrice: 100n,
      hash,
      blockHash,
      blockNumber: 100n,
    })),
    getTransactionReceipt: vi.fn(async () => ({
      transactionHash: hash,
      blockHash,
      blockNumber: 100n,
      status: 'success',
      from: unsigned.from,
      to: unsigned.to,
    })),
    getBlock: vi.fn(async (x: { blockNumber?: bigint }) => ({
      number: x.blockNumber ?? 112n,
      hash: blockHash,
    })),
  };
}
it('matches exact transaction and canonical successful receipt before confirming', async () => {
  const c = client();
  const out = await observeReceipt(
    {
      ok: true,
      maxGasCostWei: '60000000',
      maxTotalValueWei: '7',
      unsignedTransaction: unsigned,
    },
    hash,
    c as never,
  );
  expect(out.state).toBe('confirmed');
  expect(out.receipt.confirmations).toBe('13');
  expect(out.receipt.txHash).toBe(hash);
});
it('rejects mismatching user hashes and tracks revert/reorg without inventing confirmation', async () => {
  const c = client();
  c.getTransaction.mockResolvedValueOnce({
    ...(await c.getTransaction()),
    input: '0x9999',
  });
  await expect(
    observeReceipt(
      {
        ok: true,
        maxGasCostWei: '60000000',
        maxTotalValueWei: '7',
        unsignedTransaction: unsigned,
      },
      hash,
      c as never,
    ),
  ).rejects.toMatchObject({ code: 'TRANSACTION_MISMATCH' });
  c.getTransactionReceipt.mockResolvedValueOnce({
    ...(await c.getTransactionReceipt()),
    status: 'reverted',
  });
  expect(
    (
      await observeReceipt(
        {
          ok: true,
          maxGasCostWei: '60000000',
          maxTotalValueWei: '7',
          unsignedTransaction: unsigned,
        },
        hash,
        c as never,
      )
    ).state,
  ).toBe('reverted');
  c.getBlock.mockResolvedValueOnce({
    number: 100n,
    hash: ('0x' + '00'.repeat(32)) as `0x${string}`,
  });
  expect(
    (
      await observeReceipt(
        {
          ok: true,
          maxGasCostWei: '60000000',
          maxTotalValueWei: '7',
          unsignedTransaction: unsigned,
        },
        hash,
        c as never,
      )
    ).state,
  ).toBe('reorged');
});

it('keeps pending distinct from confirmations, pins hash, and proves previously confirmed reorg', async () => {
  const c = client();
  const pending = Object.assign(new Error('pending'), {
    name: 'TransactionReceiptNotFoundError',
  });
  c.getTransactionReceipt.mockRejectedValueOnce(pending);
  const out = await observeReceipt(
    {
      ok: true,
      maxGasCostWei: '60000000',
      maxTotalValueWei: '7',
      unsignedTransaction: unsigned,
    },
    hash,
    c as never,
  );
  expect(out.state).toBe('submitted');
  await expect(
    observeReceipt(
      {
        ok: true,
        maxGasCostWei: '60000000',
        maxTotalValueWei: '7',
        unsignedTransaction: unsigned,
        receipt: out.receipt,
      },
      ('0x' + '12'.repeat(32)) as `0x${string}`,
      c as never,
    ),
  ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_BOUND' });
  const prior = (
    await observeReceipt(
      {
        ok: true,
        maxGasCostWei: '60000000',
        maxTotalValueWei: '7',
        unsignedTransaction: unsigned,
      },
      hash,
      c as never,
    )
  ).receipt;
  c.getTransaction.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { name: 'TransactionNotFoundError' }),
  );
  c.getBlock.mockResolvedValueOnce({
    number: 100n,
    hash: ('0x' + '00'.repeat(32)) as `0x${string}`,
  });
  expect(
    (
      await observeReceipt(
        {
          ok: true,
          maxGasCostWei: '60000000',
          maxTotalValueWei: '7',
          unsignedTransaction: unsigned,
          receipt: prior,
        },
        hash,
        c as never,
      )
    ).state,
  ).toBe('reorged');
});

it('rejects every mismatched envelope field and does not treat RPC errors as pending', async () => {
  for (const patch of [
    { chainId: 1 },
    { from: '0x' + '11'.repeat(20) },
    { to: '0x' + '22'.repeat(20) },
    { value: 8n },
    { nonce: 9 },
  ]) {
    const c = client();
    c.getTransaction.mockResolvedValueOnce({
      ...(await c.getTransaction()),
      ...patch,
    });
    await expect(
      observeReceipt(
        {
          ok: true,
          maxGasCostWei: '60000000',
          maxTotalValueWei: '7',
          unsignedTransaction: unsigned,
        },
        hash,
        c as never,
      ),
    ).rejects.toMatchObject({ code: 'TRANSACTION_MISMATCH' });
  }
  const c = client();
  c.getTransactionReceipt.mockRejectedValueOnce(Error('RPC offline'));
  await expect(
    observeReceipt(
      {
        ok: true,
        maxGasCostWei: '60000000',
        maxTotalValueWei: '7',
        unsignedTransaction: unsigned,
      },
      hash,
      c as never,
    ),
  ).rejects.toThrow('RPC offline');
});

it('rejects an otherwise exact transaction that exceeds the immutable gas cost ceiling', async () => {
  const c = client();
  c.getTransaction.mockResolvedValueOnce({
    ...(await c.getTransaction()),
    gasPrice: 101n,
  });
  await expect(
    observeReceipt(
      {
        ok: true,
        maxGasCostWei: '60000000',
        maxTotalValueWei: '7',
        unsignedTransaction: unsigned,
      },
      hash,
      c as never,
    ),
  ).rejects.toMatchObject({ code: 'TRANSACTION_COST_CEILING_EXCEEDED' });
});
