import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  address,
  type SignatureBytes,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import { encodePumpSigningInput } from './pump-launch-signing';
import { pumpHolderDigest, type PumpHolderReview } from './pump-holder-review';
import {
  signPumpHolderPacket,
  verifyPumpHolderSignedPacket,
  type PumpHolderConsent,
} from './pump-holder-signing';

let review: PumpHolderReview,
  consent: PumpHolderConsent,
  sessions: Map<string, VaultSession>,
  vault: VaultSession,
  inactive: string;
beforeAll(async () => {
  vault = generateVaultWallets(
    await createVault('synthetic holder signing test vault'),
    'solana',
    4,
  );
  const mint = generateVaultWallets(
      await createVault('synthetic mint signing test vault'),
      'solana',
      1,
    ),
    base = await pumpCreateFixture();
  const create = {
    ...base,
    payer: vault.payload.wallets[0].address,
    mint: mint.payload.wallets[0].address,
  };
  const holders: PumpHolderBuy[] = [
    {
      address: vault.payload.wallets[1].address,
      kind: 'exact-base-output',
      tokenAmountRaw: '2000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    {
      address: vault.payload.wallets[2].address,
      kind: 'exact-base-output',
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    { address: vault.payload.wallets[3].address, kind: 'none' },
  ];
  const input = {
      create,
      holders,
      developer: {
        tokenAmountRaw: '1000000000000',
        maximumQuoteCostRaw: '100000000',
      },
    },
    packet = await buildPumpCreateHolderMessage(input);
  const document = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: base.name,
      ticker: base.symbol,
      developerBuy: 0.1,
      holdersBuy: 0.3,
      holderCount: 3,
      holdersDistribution: {
        kind: 'custom',
        weights: ['2', '1', '0'],
        deviationPercent: 0,
        seed: 'a'.repeat(32),
      },
    },
    identity: EMPTY_IDENTITY,
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        deployer: {
          address: create.payer,
          revision: 1,
          folderRevision: 0,
          root: true,
        },
        recipients: holders.map((h) => ({
          address: h.address,
          revision: 1,
          folderRevision: 0,
          root: true,
        })),
      },
    },
  });
  const allowances = {
    deployerFeeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '100000000',
    holders: holders.map((h) => ({
      address: h.address,
      feeAndRentLimitRaw: h.kind === 'none' ? '0' : '10000000',
      maximumQuoteCostRaw:
        h.kind === 'exact-base-output' ? h.maximumQuoteCostRaw : null,
      minimumTokenOutputRaw: null,
    })),
  };
  const context: Omit<PumpHolderReview, 'contextSha256'> = {
    format: 'pump-create-holders-review-v1',
    id: crypto.randomUUID(),
    projectId: 'synthetic-holder-signing',
    projectUpdatedAt: new Date().toISOString(),
    releaseId: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    transaction: packet.transaction,
    sha256: packet.packetSha256,
    input: { ...input, create: encodePumpSigningInput(create) },
    document,
    allowances,
    deployerBindingSha256: 'b'.repeat(64),
    holderBindingSha256: 'c'.repeat(64),
    allowanceSha256: createHash('sha256')
      .update(JSON.stringify(allowances))
      .digest('hex'),
  };
  review = { ...context, contextSha256: await pumpHolderDigest(context) };
  consent = {
    approved: true,
    reviewId: review.id,
    sha256: review.sha256,
    contextSha256: review.contextSha256,
    approvedScope: 'create-developer-and-holder-buys',
    acknowledgeSimulationLimits: true,
  };
  sessions = new Map([
    [create.payer, vault],
    [create.mint, mint],
    [holders[0].address, vault],
    [holders[1].address, vault],
  ]);
  inactive = holders[2].address;
});
afterEach(() => {
  vi.restoreAllMocks();
});
const sign = (supplied = sessions, current: () => void = () => {}) =>
  signPumpHolderPacket(supplied, review, consent, current);

it('signs every exact active identity locally and leaves the original packet unsigned', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Signing must not fetch'));
  const result = await sign();
  expect(await verifyPumpHolderSignedPacket(review, result.transaction)).toBe(
    result.signature,
  );
  expect(result.contextSha256).toBe(review.contextSha256);
  const tx = getTransactionDecoder().decode(
    Buffer.from(result.transaction, 'base64'),
  );
  expect(Object.keys(tx.signatures)).toHaveLength(4);
  expect(tx.signatures[address(inactive)]).toBeUndefined();
  expect(Object.values(tx.signatures).every((s) => s !== null)).toBe(true);
  expect(
    Object.values(
      getTransactionDecoder().decode(Buffer.from(review.transaction, 'base64'))
        .signatures,
    ).every((s) => s === null),
  ).toBe(true);
  expect(network).not.toHaveBeenCalled();
});
it('requires exact packet, context, scope and simulation-limit consent before signing', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached');
  for (const patch of [
    { approved: false },
    { reviewId: 'other' },
    { sha256: '0'.repeat(64) },
    { contextSha256: '0'.repeat(64) },
    { approvedScope: 'create-and-developer-buy' },
    { acknowledgeSimulationLimits: false },
  ])
    await expect(
      signPumpHolderPacket(
        sessions,
        review,
        { ...consent, ...patch } as PumpHolderConsent,
        () => {},
      ),
    ).rejects.toThrow('Explicit approval');
  expect(detached).not.toHaveBeenCalled();
});
it('rejects missing active and extra inactive sessions before signing any wallet', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached'),
    missing = new Map(sessions);
  missing.delete(review.input.holders[1].address);
  await expect(sign(missing)).rejects.toThrow('complete required signer set');
  await expect(sign(new Map([...sessions, [inactive, vault]]))).rejects.toThrow(
    'complete required signer set',
  );
  expect(detached).not.toHaveBeenCalled();
});
it('prevalidates every seed/address identity before the first signature', async () => {
  const key = review.input.holders[1].address,
    bad: VaultSession = {
      ...vault,
      payload: {
        ...vault.payload,
        wallets: vault.payload.wallets.map((w) =>
          w.address === key ? { ...w, seed: '0'.repeat(64) } : w,
        ),
      },
    },
    supplied = new Map(sessions);
  supplied.set(key, bad);
  const detached = vi.spyOn(nacl.sign, 'detached');
  await expect(sign(supplied)).rejects.toThrow('seed does not match');
  expect(detached).not.toHaveBeenCalled();
});
it('rejects ambiguous duplicate vault entries', async () => {
  const key = review.input.holders[1].address,
    supplied = new Map(sessions),
    wallet = vault.payload.wallets.find((w) => w.address === key)!;
  supplied.set(key, {
    ...vault,
    payload: { ...vault.payload, wallets: [...vault.payload.wallets, wallet] },
  });
  await expect(sign(supplied)).rejects.toThrow(
    'exact holder, deployer and mint key once',
  );
});
it('discards an interrupted partial signing result and erases temporary private bytes', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached');
  await expect(
    sign(sessions, () => {
      if (detached.mock.calls.length > 0) throw new Error('Draft changed');
    }),
  ).rejects.toThrow('Draft changed');
  expect(detached).toHaveBeenCalledTimes(1);
  expect(detached.mock.calls[0][1].every((byte) => byte === 0)).toBe(true);
});
for (const stock of [false, true])
  it(`signs holder-only creation with the exact native/stock quote context (stock=${stock})`, async () => {
    const variant = structuredClone(review),
      source = await pumpCreateFixture(stock);
    const create = {
      ...source,
      payer: review.input.create.payer,
      mint: review.input.create.mint,
    };
    variant.id = crypto.randomUUID();
    variant.projectId = 'synthetic-holder-only-' + stock;
    variant.input.create = encodePumpSigningInput(create);
    delete variant.input.developer;
    variant.document.plan.developerBuy = 0;
    variant.document.plan.currency = stock ? 'TSLAX' : 'SOL';
    variant.document.plan.quoteAddress = create.quoteMint;
    variant.allowances.developerMaximumQuoteCostRaw = null;
    const packet = await buildPumpCreateHolderMessage({
      create,
      holders: variant.input.holders,
    });
    variant.transaction = packet.transaction;
    variant.sha256 = packet.packetSha256;
    variant.allowanceSha256 = createHash('sha256')
      .update(JSON.stringify(variant.allowances))
      .digest('hex');
    const { contextSha256: _old, ...context } = variant;
    variant.contextSha256 = await pumpHolderDigest(context);
    const approval: PumpHolderConsent = {
      ...consent,
      reviewId: variant.id,
      sha256: variant.sha256,
      contextSha256: variant.contextSha256,
    };
    const signed = await signPumpHolderPacket(
      sessions,
      variant,
      approval,
      () => {},
    );
    expect(
      await verifyPumpHolderSignedPacket(variant, signed.transaction),
    ).toBe(signed.signature);
    expect(packet.containsDeveloperBuy).toBe(false);
  });
it('refuses to return a packet if the review expires after its last signature', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached'),
    now = vi.spyOn(Date, 'now');
  await expect(
    sign(sessions, () => {
      if (detached.mock.calls.length === sessions.size)
        now.mockReturnValue(Date.parse(review.expiresAt) + 1);
    }),
  ).rejects.toThrow('expired');
  expect(detached).toHaveBeenCalledTimes(4);
  expect(
    detached.mock.calls.every((call) => call[1].every((byte) => byte === 0)),
  ).toBe(true);
});
it('strictly rejects a missing or corrupt signature from the final holder', async () => {
  const signed = await sign(),
    tx = getTransactionDecoder().decode(
      Buffer.from(signed.transaction, 'base64'),
    ),
    key = address(review.input.holders[1].address);
  const missing = { ...tx, signatures: { ...tx.signatures, [key]: null } };
  await expect(
    verifyPumpHolderSignedPacket(
      review,
      getBase64Decoder().decode(getTransactionEncoder().encode(missing)),
    ),
  ).rejects.toThrow('Every exact');
  const damaged = Uint8Array.from(tx.signatures[key]!);
  damaged[0] ^= 1;
  await expect(
    verifyPumpHolderSignedPacket(
      review,
      getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { ...tx.signatures, [key]: damaged as SignatureBytes },
        }),
      ),
    ),
  ).rejects.toThrow('Every exact');
});
it('rejects noncanonical serialization, suffix bytes and a changed signed message', async () => {
  const signed = await sign();
  for (const encoded of [
    signed.transaction + '\n',
    Buffer.concat([
      Buffer.from(signed.transaction, 'base64'),
      Buffer.from([0]),
    ]).toString('base64'),
  ])
    await expect(
      verifyPumpHolderSignedPacket(review, encoded),
    ).rejects.toThrow();
  const tx = getTransactionDecoder().decode(
      Buffer.from(signed.transaction, 'base64'),
    ),
    message = Uint8Array.from(tx.messageBytes);
  message[message.length - 1] ^= 1;
  await expect(
    verifyPumpHolderSignedPacket(
      review,
      getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          messageBytes: message as unknown as typeof tx.messageBytes,
        }),
      ),
    ),
  ).rejects.toThrow('message or signer set changed');
});
it('verifies an expired saved signed packet for recovery while refusing new signing', async () => {
  const signed = await sign();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(review.expiresAt) + 1);
  expect(await verifyPumpHolderSignedPacket(review, signed.transaction)).toBe(
    signed.signature,
  );
  await expect(sign()).rejects.toThrow('expired');
});
