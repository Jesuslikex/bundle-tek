import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { AccountRole, type Instruction } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  AIRDROP_CLAWBACK_DELAY_SECONDS,
  airdropAccounts,
  airdropClaimStatus,
  airdropCreateInput,
  airdropInstructions,
  airdropLeaf,
  airdropProofRoot,
  airdropRecipients,
  airdropSchedule,
  airdropShares,
  airdropTree,
  type AirdropTerms,
} from './token-airdrop';
import { TOKEN_2022 } from './token-withdrawal-fee';

// Reference bytes produced with Streamflow's own published SDK IDL.
type Ix = { program: string; data: string; keys: [string, boolean, boolean][] };
const golden = JSON.parse(
  readFileSync('test/streamflow-distributor-sdk-golden.json', 'utf8'),
) as Record<
  string,
  {
    distributor: string;
    vault: string;
    claimStatus: string;
    create: Ix;
    claim: Ix;
    clawback: Ix;
  }
> & { leaves: string[] };
const ADMIN = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  RECIPIENTS = [
    'SysvarRent111111111111111111111111111111111',
    'SysvarC1ock11111111111111111111111111111111',
    'Stake11111111111111111111111111111111111111',
  ];
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const shape = (ix: Instruction) => ({
  program: ix.programAddress as string,
  data: hex(Uint8Array.from(ix.data ?? [])),
  keys: (ix.accounts ?? []).map((a) => [
    a.address as string,
    a.role === AccountRole.WRITABLE_SIGNER ||
      a.role === AccountRole.READONLY_SIGNER,
    a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.WRITABLE,
  ]),
});
const terms = (program: string): AirdropTerms => ({
  airdropId: '11111111-1111-4111-8111-111111111111',
  version: '1794860000123',
  distributor: golden[program].distributor,
  vault: golden[program].vault,
  root: sha('root'),
  perRecipientRaw: '1000000',
  startTs: 1800000000,
  endTs: 1800000001,
  clawbackTs: 1800086461,
  creator: ADMIN,
});

it.each([TOKEN_PROGRAM_ADDRESS, TOKEN_2022] as const)(
  'matches the Streamflow SDK accounts and instruction bytes for %s',
  async (program) => {
    const g = golden[program];
    expect(
      await airdropAccounts({ mint: MINT, program, version: 1794860000123n }),
    ).toEqual({ distributor: g.distributor, vault: g.vault });
    expect(await airdropClaimStatus(g.distributor, RECIPIENTS[1])).toBe(
      g.claimStatus,
    );
    const base = { mint: MINT, program, decimals: 6 };
    const create = await airdropInstructions({
      ...base,
      kind: 'create',
      wallet: ADMIN,
      terms: { ...terms(program), recipients: RECIPIENTS },
    });
    expect(shape(create.instructions[0])).toEqual(g.create);
    // The deposit follows the distributor: exactly the claimable total into its vault.
    const deposit = shape(create.instructions[1]);
    expect(deposit.program).toBe(program);
    expect(deposit.keys.map((k) => k[0])).toEqual([
      create.tokenAccount,
      MINT,
      g.vault,
      ADMIN,
    ]);
    expect(deposit.data).toBe('0c' + 'c0c62d0000000000' + '06');
    const claim = await airdropInstructions({
      ...base,
      kind: 'claim',
      wallet: RECIPIENTS[1],
      terms: { ...terms(program), proof: [sha('p1'), sha('p2')] },
    });
    expect(claim.instructions).toHaveLength(2);
    expect(shape(claim.instructions[1])).toEqual(g.claim);
    const clawback = await airdropInstructions({
      ...base,
      kind: 'clawback',
      wallet: ADMIN,
      terms: terms(program),
    });
    expect(shape(clawback.instructions[1])).toEqual(g.clawback);
  },
);

it('hashes leaves like the distributor and builds proofs that fold back to the root', async () => {
  for (const [i, r] of RECIPIENTS.entries())
    expect(hex(await airdropLeaf(r, 1_000_000n))).toBe(golden.leaves[i]);
  for (const count of [1, 2, 3, 5, 8, 13, 20]) {
    const wallets = Array.from({ length: count }, (_, i) =>
      bs58.encode(new Uint8Array(32).fill(i + 1)),
    );
    const tree = await airdropTree(wallets, 777n);
    for (const [i, w] of wallets.entries()) {
      expect(tree.proofs[i].length).toBeLessThanOrEqual(5);
      const proof = tree.proofs[i].map((h) => Buffer.from(h, 'hex'));
      expect(
        hex(await airdropProofRoot(await airdropLeaf(w, 777n), proof)),
      ).toBe(tree.root);
      // Another amount or another wallet does not verify.
      expect(
        hex(await airdropProofRoot(await airdropLeaf(w, 778n), proof)),
      ).not.toBe(tree.root);
    }
  }
});

it('refuses wrong recipients, terms and signers', async () => {
  expect(() => airdropRecipients([], ADMIN)).toThrow();
  expect(() =>
    airdropRecipients([RECIPIENTS[0], RECIPIENTS[0]], ADMIN),
  ).toThrow('once');
  expect(() => airdropRecipients([ADMIN], ADMIN)).toThrow('input wallet');
  expect(() =>
    airdropRecipients(
      Array.from({ length: 21 }, (_, i) =>
        bs58.encode(new Uint8Array(32).fill(i + 1)),
      ),
      ADMIN,
    ),
  ).toThrow('between 1 and 20');
  const body = {
    wallet: ADMIN,
    walletRevision: 1,
    mint: MINT,
    percent: '50',
    recipients: RECIPIENTS,
    acknowledgeAirdrop: true,
  };
  expect(airdropCreateInput(body).percentPpm).toBe(500_000n);
  expect(() =>
    airdropCreateInput({ ...body, acknowledgeAirdrop: false }),
  ).toThrow('Acknowledge');
  expect(() => airdropCreateInput({ ...body, mint: ADMIN })).toThrow();
  expect(airdropShares(1_000_001n, 500_000n, 3)).toEqual({
    perRecipient: 166_666n,
    total: 499_998n,
  });
  expect(() => airdropShares(5n, 500_000n, 3)).toThrow('below one');
  const s = airdropSchedule('2026-11-11T12:00:00.000Z');
  expect(s.endTs).toBe(s.startTs + 1);
  // Jito's rule the fork inherits: clawback at least one day after vesting ends.
  expect(s.clawbackTs - s.endTs).toBe(AIRDROP_CLAWBACK_DELAY_SECONDS);
  expect(AIRDROP_CLAWBACK_DELAY_SECONDS).toBeGreaterThan(86_400);
  const t = terms(TOKEN_PROGRAM_ADDRESS);
  const base = {
    mint: MINT,
    program: TOKEN_PROGRAM_ADDRESS,
    decimals: 6,
  } as const;
  await expect(
    airdropInstructions({
      ...base,
      kind: 'clawback',
      wallet: RECIPIENTS[0],
      terms: t,
    }),
  ).rejects.toThrow('Only the creating wallet');
  await expect(
    airdropInstructions({
      ...base,
      kind: 'create',
      wallet: ADMIN,
      terms: { ...t, version: '5', recipients: RECIPIENTS },
    }),
  ).rejects.toThrow('accounts differ');
});
