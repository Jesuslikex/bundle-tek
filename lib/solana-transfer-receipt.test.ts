import { describe, it, expect, vi } from 'vitest';
import {
  tokenReceiptFixture,
  memoReceiptFixture,
  failedMemoReceiptFixture,
  failedTokenReceiptFixture,
  receiptClaim,
  receiptWallet,
  receiptRecipient,
  receiptSignature,
  nativeFundingInput,
  nativeReceiptFixture,
} from '../test/devnet-receipt-fixture';
import {
  readFinalizedDevnetTransaction,
  verifyTokenReceipt,
  verifyMemoReceipt,
  verifyNativeFundingReceipt,
  readDevnetOperationSlot,
} from './solana-transfer-receipt';
import { distributionAuditKey } from './distribution-audit';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
import { address } from '@solana/kit';
import { operationDocument } from './wallet-operation';

describe('finalized devnet receipts', () => {
  it('verifies exact native funding instruction and effective SOL changes, including failed rollback', async () => {
    const intent = await operationDocument(nativeFundingInput);
    if (intent.kind !== 'sol') throw new Error();
    expect(
      verifyNativeFundingReceipt(
        nativeReceiptFixture(),
        receiptSignature,
        intent,
      ),
    ).toMatchObject({
      amount: '0.300000001',
      rawAmount: '300000001',
      feeLamports: '5000',
      fundingKey: intent.fundingKey,
    });
    expect(
      verifyNativeFundingReceipt(
        nativeReceiptFixture(true),
        receiptSignature,
        intent,
        true,
      ),
    ).toMatchObject({
      transactionError: '{"InstructionError":[0,{"Custom":1}]}',
    });
    const unsafe = nativeReceiptFixture();
    unsafe.meta.preBalances[0] = '9007199254740993000';
    unsafe.meta.postBalances[0] = '9007199254440987999';
    expect(
      verifyNativeFundingReceipt(unsafe, receiptSignature, intent).rawAmount,
    ).toBe('300000001');
  });
  it('rejects wrong native amount, destination, additional effects, signer and missing balance evidence', async () => {
    const intent = await operationDocument(nativeFundingInput);
    if (intent.kind !== 'sol') throw new Error();
    const changes = [
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.transaction.message.instructions[0].parsed.info.lamports =
          '300000000';
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.transaction.message.instructions[0].parsed.info.destination =
          receiptWallet;
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.meta.postBalances[1] = '300000000';
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.meta.postBalances[2] = '2';
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.transaction.message.accountKeys[1].signer = true;
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.transaction.message.accountKeys[1].writable = false;
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.transaction.message.instructions.push(
          tx.transaction.message.instructions[0],
        );
      },
      (tx: ReturnType<typeof nativeReceiptFixture>) => {
        tx.meta.postBalances = [];
      },
    ];
    for (const change of changes) {
      const tx = nativeReceiptFixture();
      change(tx);
      expect(() =>
        verifyNativeFundingReceipt(tx, receiptSignature, intent),
      ).toThrow();
    }
    const failed = nativeReceiptFixture(true);
    failed.meta.postBalances[1] = '1';
    expect(() =>
      verifyNativeFundingReceipt(failed, receiptSignature, intent, true),
    ).toThrow('beyond its fee');
  });
  it('keeps native funding identities stable across revisions while binding amount, funder, plan and recipient', async () => {
    const original = await operationDocument(nativeFundingInput);
    if (original.kind !== 'sol') throw new Error();
    const changed = await operationDocument({
      ...nativeFundingInput,
      fundingRevision: 2,
    });
    expect(changed).toMatchObject({ fundingKey: original.fundingKey });
    for (const patch of [
      { amount: '0.3' },
      { fundingId: 'other' },
      { wallet: receiptRecipient, recipient: receiptWallet },
    ]) {
      const intent = await operationDocument({
        ...nativeFundingInput,
        ...patch,
      });
      expect(intent).not.toMatchObject({ fundingKey: original.fundingKey });
    }
    for (const patch of [
      { amount: '0' },
      { amount: '0.0000000001' },
      { fundingRevision: 0 },
      { recipient: receiptWallet },
      { fundingId: 'bad/id' },
    ])
      await expect(
        operationDocument({ ...nativeFundingInput, ...patch }),
      ).rejects.toThrow();
  });
  it('verifies real RPC integer-string parsing and exact large native fee accounting on failure', async () => {
    const tx = await failedTokenReceiptFixture();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: body.method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : tx,
      });
    });
    const evidence = await readFinalizedDevnetTransaction(
      receiptSignature,
      fetcher as typeof fetch,
    );
    await expect(
      verifyTokenReceipt(
        evidence,
        receiptSignature,
        receiptClaim,
        receiptRecipient,
        true,
      ),
    ).resolves.toMatchObject({
      transactionError: JSON.stringify(tx.meta.err),
      feeLamports: '5000',
    });
    const memo = failedMemoReceiptFixture();
    expect(
      verifyMemoReceipt(
        {
          ...memo,
          meta: {
            ...memo.meta,
            preBalances: ['10000000000000000'],
            postBalances: ['9999999999995000'],
          },
        },
        receiptSignature,
        receiptWallet,
        true,
      ),
    ).toMatchObject({ feeLamports: '5000' });
  });
  it('verifies a failed memo with the exact signer, intent and fee-only balance change', () => {
    const tx = failedMemoReceiptFixture();
    expect(
      verifyMemoReceipt(tx, receiptSignature, receiptWallet, true),
    ).toMatchObject({
      feeLamports: '5000',
      transactionError: JSON.stringify(tx.meta.err),
      commitment: 'finalized',
    });
    expect(() =>
      verifyMemoReceipt(tx, receiptSignature, receiptWallet),
    ).toThrow('did not succeed');
    expect(() => verifyMemoReceipt(tx, 'wrong', receiptWallet, true)).toThrow(
      'signature',
    );
    tx.transaction.message.instructions[0].parsed = 'other application';
    expect(() =>
      verifyMemoReceipt(tx, receiptSignature, receiptWallet, true),
    ).toThrow('reviewed');
  });
  it('rejects missing, malformed or inconsistent finalized failure metadata', () => {
    const base = failedMemoReceiptFixture();
    for (const patch of [
      { err: null },
      { err: undefined },
      { err: {} },
      { err: { InstructionError: [2, 'Custom'] } },
      { err: { InstructionError: [0, { Custom: -1 }] } },
      { fee: '5000x' },
      { preBalances: [] },
      { postBalances: [994999] },
    ])
      expect(() =>
        verifyMemoReceipt(
          { ...base, meta: { ...base.meta, ...patch } },
          receiptSignature,
          receiptWallet,
          true,
        ),
      ).toThrow();
  });
  it('verifies failed token intent without marking the requested amount delivered', async () => {
    const tx = await failedTokenReceiptFixture();
    await expect(
      verifyTokenReceipt(
        tx,
        receiptSignature,
        receiptClaim,
        receiptRecipient,
        true,
      ),
    ).resolves.toMatchObject({
      amount: '0.300000001',
      feeLamports: '5000',
      transactionError: JSON.stringify(tx.meta.err),
    });
    tx.meta.postTokenBalances[1].uiTokenAmount.amount = '1';
    await expect(
      verifyTokenReceipt(
        tx,
        receiptSignature,
        receiptClaim,
        receiptRecipient,
        true,
      ),
    ).rejects.toThrow('balance changes');
  });
  it('allows absent token accounts on a rolled-back failure but rejects another attempted transfer', async () => {
    const tx = await failedTokenReceiptFixture();
    tx.meta.preTokenBalances = [];
    tx.meta.postTokenBalances = [];
    await expect(
      verifyTokenReceipt(
        tx,
        receiptSignature,
        receiptClaim,
        receiptRecipient,
        true,
      ),
    ).resolves.toMatchObject({ feeLamports: '5000' });
    tx.transaction.message.instructions[0].parsed.info.tokenAmount.amount = '1';
    await expect(
      verifyTokenReceipt(
        tx,
        receiptSignature,
        receiptClaim,
        receiptRecipient,
        true,
      ),
    ).rejects.toThrow('reviewed');
  });
  it('pins operation preparation to a confirmed slot on the verified devnet cluster', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (body.method === 'getSlot')
        expect(body.params).toEqual([{ commitment: 'confirmed' }]);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: body.method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : 12344,
      });
    });
    await expect(
      readDevnetOperationSlot(fetcher as typeof fetch),
    ).resolves.toBe(12344);
    const wrong = vi.fn(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: 'other network' }),
    );
    await expect(
      readDevnetOperationSlot(wrong as typeof fetch),
    ).rejects.toThrow('not Solana devnet');
    expect(wrong).toHaveBeenCalledTimes(1);
  });
  it('enforces a deadline even when the provider ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const pending = readFinalizedDevnetTransaction(
        receiptSignature,
        (() => new Promise<Response>(() => {})) as typeof fetch,
      );
      const assertion = expect(pending).rejects.toMatchObject({ status: 502 });
      await vi.advanceTimersByTimeAsync(25001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('verifies exact checked-transfer amounts and both effective balance changes', async () => {
    const receipt = await verifyTokenReceipt(
      await tokenReceiptFixture(),
      receiptSignature,
      receiptClaim,
      receiptRecipient,
    );
    expect(receipt).toMatchObject({
      rawAmount: '300000001',
      amount: '0.300000001',
      decimals: 9,
      commitment: 'finalized',
      distributionKey: await distributionAuditKey(receiptClaim),
    });
  });
  it('accepts a matching idempotent recipient ATA creation with no prior token balance', async () => {
    const tx = await tokenReceiptFixture();
    tx.meta.preTokenBalances.pop();
    const info = tx.transaction.message.instructions[0].parsed.info;
    (tx.transaction.message.instructions as unknown[]).unshift({
      programId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      parsed: {
        type: 'createIdempotent',
        info: {
          account: info.destination,
          mint: receiptClaim.mint,
          wallet: receiptRecipient,
          source: receiptWallet,
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      },
    });
    await expect(
      verifyTokenReceipt(tx, receiptSignature, receiptClaim, receiptRecipient),
    ).resolves.toMatchObject({ amount: '0.300000001' });
  });
  it('rejects wrong signer, signature, mint, owner, amount, account and balance deltas', async () => {
    const changes: Array<
      (tx: Awaited<ReturnType<typeof tokenReceiptFixture>>) => void
    > = [
      (tx) => {
        tx.transaction.message.accountKeys[0].signer = false;
      },
      (tx) => {
        tx.transaction.signatures[0] = 'wrong';
      },
      (tx) => {
        tx.transaction.message.instructions[0].parsed.info.mint =
          receiptRecipient;
      },
      (tx) => {
        tx.transaction.message.instructions[0].parsed.info.authority =
          receiptRecipient;
      },
      (tx) => {
        tx.transaction.message.instructions[0].parsed.info.tokenAmount.amount =
          '300000000';
      },
      (tx) => {
        tx.transaction.message.instructions[0].parsed.info.destination =
          address(receiptWallet);
      },
      (tx) => {
        tx.meta.postTokenBalances[1].uiTokenAmount.amount = '300000000';
      },
      (tx) => {
        tx.meta.postTokenBalances[0].uiTokenAmount.amount = '700000000';
      },
      (tx) => {
        tx.meta.preTokenBalances[0].owner = receiptRecipient;
      },
      (tx) => {
        tx.meta.postTokenBalances[1].uiTokenAmount.decimals = 8;
      },
      (tx) => {
        tx.meta.postTokenBalances.push(tx.meta.postTokenBalances[1]);
      },
      (tx) => {
        tx.meta.preTokenBalances.shift();
      },
      (tx) => {
        tx.meta.postTokenBalances[1].uiTokenAmount.amount =
          '18446744073709551616';
      },
      (tx) => {
        tx.transaction.message.instructions.push(
          tx.transaction.message.instructions[0],
        );
      },
      (tx) => {
        (tx.meta as { err: unknown }).err = { InstructionError: [0, 'error'] };
      },
      (tx) => {
        (tx.transaction.message.instructions as unknown[]).push({
          programId: '11111111111111111111111111111111',
          parsed: { type: 'transfer' },
        });
      },
    ];
    for (const change of changes) {
      const tx = await tokenReceiptFixture();
      change(tx);
      await expect(
        verifyTokenReceipt(
          tx,
          receiptSignature,
          receiptClaim,
          receiptRecipient,
        ),
      ).rejects.toThrow();
    }
  });
  it('admits only a successful memo signed by the reviewed fee payer', () => {
    expect(
      verifyMemoReceipt(memoReceiptFixture(), receiptSignature, receiptWallet),
    ).toMatchObject({ commitment: 'finalized' });
    const tx = memoReceiptFixture();
    tx.transaction.message.instructions[0].parsed = 'other application';
    expect(() =>
      verifyMemoReceipt(tx, receiptSignature, receiptWallet),
    ).toThrow();
    expect(() =>
      verifyMemoReceipt(
        memoReceiptFixture(),
        receiptSignature,
        receiptRecipient,
      ),
    ).toThrow();
  });
  it('checks genesis before requesting finalized parsed evidence and preserves integer values', async () => {
    const tx = await tokenReceiptFixture(),
      calls: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      calls.push(body);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: body.method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : tx,
      });
    });
    const result = await readFinalizedDevnetTransaction(
      receiptSignature,
      fetcher as typeof fetch,
    );
    expect(calls).toEqual([
      expect.objectContaining({ method: 'getGenesisHash' }),
      expect.objectContaining({
        method: 'getTransaction',
        params: [
          receiptSignature,
          {
            commitment: 'finalized',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    ]);
    await expect(
      verifyTokenReceipt(
        result,
        receiptSignature,
        receiptClaim,
        receiptRecipient,
      ),
    ).resolves.toMatchObject({ slot: 12345 });
  });
  it('rejects another chain, unavailable finalized evidence and oversized provider responses', async () => {
    const wrong = vi.fn(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: 'mainnet' }),
    );
    await expect(
      readFinalizedDevnetTransaction(receiptSignature, wrong as typeof fetch),
    ).rejects.toThrow('not Solana devnet');
    expect(wrong).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async (_url: unknown, init?: RequestInit) =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result:
          JSON.parse(init!.body as string).method === 'getGenesisHash'
            ? DEVNET_GENESIS_HASH
            : null,
      }),
    );
    await expect(
      readFinalizedDevnetTransaction(receiptSignature, missing as typeof fetch),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readFinalizedDevnetTransaction(
        receiptSignature,
        (async () => new Response(' '.repeat(524289))) as typeof fetch,
      ),
    ).rejects.toThrow('too large');
  });
  it('uses a canonical exact manifest identity independent of labels and row order', async () => {
    const other = { address: receiptClaim.mint, amount: '1' };
    expect(
      await distributionAuditKey({
        ...receiptClaim,
        recipients: [...receiptClaim.recipients, other],
      }),
    ).toBe(
      await distributionAuditKey({
        ...receiptClaim,
        recipients: [other, ...receiptClaim.recipients],
      }),
    );
    expect(await distributionAuditKey(receiptClaim)).not.toBe(
      await distributionAuditKey({
        ...receiptClaim,
        recipients: [{ address: receiptRecipient, amount: '0.3' }],
      }),
    );
  });
});
