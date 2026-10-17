import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { Clanker } from 'clanker-sdk/v4';
import {
  CLANKER_V4_FACTORY_BASE,
  clankerDeployCall,
  validateClankerDraft,
  walletRequestParams,
} from './launch';

const admin = '0x1111111111111111111111111111111111111111';

describe('clanker launch', () => {
  it('builds a deployToken call to the official Base factory', async () => {
    const call = await clankerDeployCall({
      name: 'Test',
      symbol: 'TST',
      image: '',
      admin,
    });
    expect(call.to).toBe(CLANKER_V4_FACTORY_BASE);
    expect(call.value).toBe(0n);
    expect(call.chainId).toBe(8453);
    const { abi } = await new Clanker({}).getDeployTransaction({
      name: 'x',
      symbol: 'X',
      tokenAdmin: admin,
      chainId: 8453,
    });
    const decoded = decodeFunctionData({ abi, data: call.data });
    expect(decoded.functionName).toBe('deployToken');
    const cfg = (
      decoded.args[0] as {
        tokenConfig: { name: string; symbol: string; tokenAdmin: string };
      }
    ).tokenConfig;
    expect(cfg).toMatchObject({
      name: 'Test',
      symbol: 'TST',
      tokenAdmin: admin,
    });
    expect(walletRequestParams(call)[0].value).toBe('0x0');
  });

  it('refuses a factory that is not the official one', async () => {
    const sdk = {
      getDeployTransaction: async () => ({
        address: admin,
        abi: [],
        functionName: 'x',
        args: [],
      }),
    };
    await expect(
      clankerDeployCall(
        { name: 'T', symbol: 'T', image: '', admin },
        sdk as never,
      ),
    ).rejects.toThrow(/unexpected factory/);
  });

  it('validates the draft', () => {
    expect(() =>
      validateClankerDraft({ name: '', symbol: 'T', image: '', admin }),
    ).toThrow();
    expect(() =>
      validateClankerDraft({ name: 'a', symbol: 'T-1', image: '', admin }),
    ).toThrow();
    expect(() =>
      validateClankerDraft({
        name: 'a',
        symbol: 'T',
        image: 'http://x',
        admin,
      }),
    ).toThrow();
    expect(() =>
      validateClankerDraft({
        name: 'a',
        symbol: 'T',
        image: '',
        admin: 'nope',
      }),
    ).toThrow();
  });
});
