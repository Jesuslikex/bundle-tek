import { it, expect } from 'vitest';
import { decodeFunctionData, zeroAddress } from 'viem';
import { buildLaunch, routerAbi, ROUTER } from './chain';
import { validateIntent } from './intent';
import { sample } from './testing';
it('encodes documented native router tuple and exact fee plus buy allocation', () => {
  const pin = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const tx = buildLaunch(validateIntent(sample), pin, 17n);
  const decoded = decodeFunctionData({ abi: routerAbi, data: tx.data });
  expect(tx.to).toBe(ROUTER);
  expect(tx.value).toBe(BigInt(sample.quoteInWei) + 17n);
  expect(decoded.functionName).toBe('launchAndBuy');
  expect(decoded.args[0].expectedEconomics).toBe(pin);
  expect(decoded.args[2]).toBe(zeroAddress);
  expect(decoded.args[3]).toBe(BigInt(sample.quoteInWei));
  expect(decoded.args[5].toLowerCase()).toBe(sample.recipient.toLowerCase());
});
