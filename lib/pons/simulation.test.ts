import { it, expect } from 'vitest';
import { simulateIntent } from './simulation';
import { validateIntent } from './intent';
import { sample } from './testing';

import { fakeClient } from './testing';
it('reads live policy, pins economics, calls and estimates the exact unsigned transaction', async () => {
  const client = fakeClient(1000);
  const s = await simulateIntent(validateIntent(sample), client as never, 1000);
  expect(s.ok).toBe(true);
  expect(s.nonceStatus).toBe('not reserved');
  expect(s.expiresAt).toBe(121000);
  expect(s.unsignedTransaction.nonce).toBe(8);
  expect(client.call).toHaveBeenCalledOnce();
  expect(client.estimateGas).toHaveBeenCalledOnce();
  expect(s.output.tokensOut).toBe('3');
  expect(s.unsignedTransaction.value).toBe(
    (BigInt(sample.quoteInWei) + 7n).toString(),
  );
  expect(
    client.readContract.mock.calls.filter(
      ([x]) => x.functionName === 'canLaunch',
    ).length,
  ).toBe(2);
});

it('fails closed on launch policy, funds, disabled config, wrong chain and changed block', async () => {
  for (const code of [
    'LAUNCH_GATE_CLOSED',
    'INSUFFICIENT_ETH',
    'CONFIG_DISABLED',
    'WRONG_RPC_CHAIN',
    'SIMULATION_BLOCK_REORG',
  ]) {
    const c = fakeClient();
    if (code === 'LAUNCH_GATE_CLOSED')
      c.readContract.mockImplementation(async (x) =>
        x.functionName === 'canLaunch'
          ? false
          : {
              factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
              launchConfigCount: 1n,
              getLaunchConfig: {
                enabled: true,
                supply: 1000n,
                curveFeeBps: 30n,
              },
              launchFee: 7n,
              maxCreatorTaxBps: 1000n,
              previewLaunchEconomics: '0x' + '22'.repeat(32),
            }[x.functionName],
      );
    if (code === 'INSUFFICIENT_ETH') c.getBalance.mockResolvedValue(0n);
    if (code === 'CONFIG_DISABLED')
      c.readContract.mockImplementation(
        async (x) =>
          ({
            factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
            canLaunch: true,
            launchConfigCount: 0n,
            getLaunchConfig: {
              enabled: false,
              supply: 1000n,
              curveFeeBps: 30n,
            },
            launchFee: 7n,
            maxCreatorTaxBps: 1000n,
            previewLaunchEconomics: '0x' + '22'.repeat(32),
          })[x.functionName],
      );
    if (code === 'WRONG_RPC_CHAIN') c.getChainId.mockResolvedValue(1);
    if (code === 'SIMULATION_BLOCK_REORG')
      c.getBlock.mockResolvedValueOnce({
        number: 100n,
        hash: '0x' + '99'.repeat(32),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      });
    await expect(
      simulateIntent(validateIntent(sample), c as never),
    ).rejects.toMatchObject({ code });
  }
});
it('verifies the router factory binding rather than trusting deployed bytecode alone', async () => {
  const c = fakeClient();
  c.readContract.mockImplementation(async (x) =>
    x.functionName === 'factory'
      ? '0x0000000000000000000000000000000000000001'
      : {
          factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
          canLaunch: true,
          launchConfigCount: 1n,
          getLaunchConfig: { enabled: true, supply: 1000n, curveFeeBps: 30n },
          launchFee: 7n,
          maxCreatorTaxBps: 1000n,
          previewLaunchEconomics: '0x' + '22'.repeat(32),
        }[x.functionName],
  );
  await expect(
    simulateIntent(validateIntent(sample), c as never),
  ).rejects.toMatchObject({ code: 'ROUTER_FACTORY_MISMATCH' });
});

it('rejects fee-inclusive value and buffered gas over immutable user ceilings', async () => {
  await expect(
    simulateIntent(
      validateIntent({ ...sample, maxTotalValueWei: sample.quoteInWei }),
      fakeClient() as never,
    ),
  ).rejects.toMatchObject({ code: 'TOTAL_VALUE_CEILING_EXCEEDED' });
  await expect(
    simulateIntent(
      validateIntent({ ...sample, maxGasCostWei: '1' }),
      fakeClient() as never,
    ),
  ).rejects.toMatchObject({ code: 'GAS_COST_CEILING_EXCEEDED' });
});

it('rejects stale RPC heads instead of refreshing stale economics into a new handoff', async () => {
  const c = fakeClient();
  c.getBlock.mockResolvedValue({
    number: 100n,
    hash: '0x' + '11'.repeat(32),
    timestamp: 1n,
  } as never);
  await expect(
    simulateIntent(validateIntent(sample), c as never),
  ).rejects.toMatchObject({ code: 'RPC_BLOCK_STALE' });
});
it('carries the checked fee bound in the actual unsigned envelope', async () => {
  const out = await simulateIntent(
    validateIntent(sample),
    fakeClient() as never,
  );
  expect(out.unsignedTransaction).toHaveProperty('gasPrice', '100');
  expect(
    BigInt(out.unsignedTransaction.gas) *
      BigInt((out.unsignedTransaction as { gasPrice: string }).gasPrice),
  ).toBeLessThanOrEqual(BigInt(sample.maxGasCostWei));
});

it('requires an actual timestamp in the RPC snapshot and records it', async () => {
  const c = fakeClient();
  c.getBlock.mockResolvedValueOnce({
    number: 100n,
    hash: '0x' + '11'.repeat(32),
  } as never);
  await expect(
    simulateIntent(validateIntent(sample), c as never),
  ).rejects.toMatchObject({ code: 'INVALID_BLOCK_TIMESTAMP' });
  const out = await simulateIntent(
    validateIntent(sample),
    fakeClient(1000) as never,
    1000,
  );
  expect(out).toHaveProperty('blockTimestamp', '1');
});

it('simulates the exact fee/nonce envelope, including its buffered gas limit', async () => {
  const c = fakeClient();
  const out = await simulateIntent(validateIntent(sample), c as never);
  expect(c.estimateGas).toHaveBeenCalledWith(
    expect.objectContaining({ gasPrice: 100n, nonce: 8 }),
  );
  expect(c.call).toHaveBeenCalledWith(
    expect.objectContaining({
      gasPrice: 100n,
      nonce: 8,
      gas: BigInt(out.unsignedTransaction.gas),
    }),
  );
});
