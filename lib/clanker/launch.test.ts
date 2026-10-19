import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseEther } from 'viem';
import { Clanker } from 'clanker-sdk/v4';
import {
  BANKR_INTERFACE_ADDRESS,
  CLANKER_V4_DEVBUY_BASE,
  CLANKER_V4_FACTORY_BASE,
  CLANKER_V4_VAULT_BASE,
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

  const base = { name: 'Test', symbol: 'TST', image: '', admin };

  async function decode(data: `0x${string}`) {
    const { abi } = await new Clanker({}).getDeployTransaction({
      name: 'x',
      symbol: 'X',
      tokenAdmin: admin,
      chainId: 8453,
    });
    return decodeFunctionData({ abi, data }).args[0] as unknown as {
      tokenConfig: { context: string };
      lockerConfig: {
        rewardRecipients: string[];
        rewardBps: number[];
      };
      extensionConfigs: {
        extension: string;
        msgValue: bigint;
        extensionBps: number;
      }[];
    };
  }

  it('tags Bankr launches and splits fees 80/20 with Bankr', async () => {
    const call = await clankerDeployCall({ ...base, venue: 'Bankr' });
    const args = await decode(call.data);
    expect(JSON.parse(args.tokenConfig.context).interface).toBe('Bankr');
    expect(args.lockerConfig.rewardRecipients).toEqual([
      admin,
      BANKR_INTERFACE_ADDRESS,
    ]);
    expect(args.lockerConfig.rewardBps).toEqual([8000, 2000]);
    expect(call.summary.rewards.map((r) => r.bps)).toEqual([8000, 2000]);
  });

  it('keeps all Clanker fees with the creator', async () => {
    const call = await clankerDeployCall(base);
    const args = await decode(call.data);
    expect(JSON.parse(args.tokenConfig.context).interface).toBe('Clanker');
    expect(args.lockerConfig.rewardRecipients).toEqual([admin]);
    expect(args.lockerConfig.rewardBps).toEqual([10000]);
    expect(args.extensionConfigs).toEqual([]);
  });

  it('sends exactly the dev buy as ETH value and locks the vault', async () => {
    const call = await clankerDeployCall({
      ...base,
      devBuyEth: '0.015',
      vaultPercent: '10',
      vaultDays: '30',
    });
    expect(call.value).toBe(parseEther('0.015'));
    expect(walletRequestParams(call)[0].value).toBe(
      '0x' + parseEther('0.015').toString(16),
    );
    const ext = (await decode(call.data)).extensionConfigs;
    expect(ext.map((e) => e.extension)).toEqual([
      CLANKER_V4_VAULT_BASE,
      CLANKER_V4_DEVBUY_BASE,
    ]);
    expect(ext[0].extensionBps).toBe(1000);
    expect(ext[1].msgValue).toBe(parseEther('0.015'));
    expect(call.summary).toMatchObject({
      devBuyWei: parseEther('0.015'),
      vault: { percent: 10, days: 30 },
    });
  });

  it('refuses SDK output that differs from the review', async () => {
    const real = new Clanker({});
    const tamper = (edit: (args: Record<string, never>) => void) =>
      ({
        getDeployTransaction: async (cfg: never) => {
          const tx = await real.getDeployTransaction(cfg);
          const args = structuredClone(tx.args) as unknown as [
            Record<string, never>,
          ];
          edit(args[0]);
          return { ...tx, args };
        },
      }) as never;
    await expect(
      clankerDeployCall(
        { ...base, venue: 'Bankr' },
        tamper((a) => {
          (
            a.lockerConfig as { rewardRecipients: string[] }
          ).rewardRecipients[1] = admin;
        }),
      ),
    ).rejects.toThrow(/fee recipients/);
    await expect(
      clankerDeployCall(
        { ...base, devBuyEth: '0.01' },
        tamper((a) => {
          (a.extensionConfigs as { msgValue: bigint }[])[0].msgValue = 1n;
        }),
      ),
    ).rejects.toThrow(/dev buy/);
    await expect(
      clankerDeployCall(
        base,
        tamper((a) => {
          (a.tokenConfig as { tokenAdmin: string }).tokenAdmin =
            BANKR_INTERFACE_ADDRESS;
        }),
      ),
    ).rejects.toThrow(/reviewed token/);
  });

  it('validates dev buy and vault inputs', () => {
    for (const devBuyEth of ['0', '-1', '1e3', '0.0000001', '6'])
      expect(() => validateClankerDraft({ ...base, devBuyEth })).toThrow();
    for (const [vaultPercent, vaultDays] of [
      ['91', '30'],
      ['10', '6'],
      ['10', ''],
      ['1.5', '30'],
    ])
      expect(() =>
        validateClankerDraft({ ...base, vaultPercent, vaultDays }),
      ).toThrow();
    expect(validateClankerDraft({ ...base, vaultPercent: '0' }).vault).toBe(
      null,
    );
  });
});
