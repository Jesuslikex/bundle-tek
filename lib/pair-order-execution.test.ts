import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pairExecutionFixture } from '../test/pair-order-execution-fixture';
import {
  decodePairOrderReceipt,
  pairOrderReservationAvailable,
  readOwnedPairOrderExecution,
  recoverPairOrderExecution,
  registerPairOrderSignature,
  submitPairOrderExecution,
} from './pair-order-execution';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

let f: Awaited<ReturnType<typeof pairExecutionFixture>>;
beforeEach(async () => {
  f = await pairExecutionFixture();
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  f.close();
});
const signal = () => new AbortController().signal;
const consentFor = (id: string, signature: string) => ({
  authorizationId: id,
  packetSha256: f.packetSha256,
  signature,
  sendExactSignedPacketOnce: true as const,
});
function provider(
  overrides: Record<string, (params: unknown[]) => unknown> = {},
) {
  const calls: string[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    calls.push(method);
    if (overrides[method]) return overrides[method](params);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getBlockHeight') return '100';
    throw Error(`unexpected ${method}`);
  });
  return { rpc, calls };
}
async function signed() {
  const r = f.reserve();
  const s = f.sign();
  await registerPairOrderSignature(
    f.db,
    'alice',
    r.authorizationId,
    s.signedPacket,
  );
  return { ...r, ...s };
}

it('keeps every write action off unless the server flag is exactly true', async () => {
  const r = f.reserve();
  const s = f.sign();
  for (const value of [undefined, '', 'TRUE', '1', 'yes', ' true']) {
    if (value === undefined)
      vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', undefined);
    else vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', value);
    await expect(
      registerPairOrderSignature(
        f.db,
        'alice',
        r.authorizationId,
        s.signedPacket,
      ),
    ).rejects.toThrow(/disabled/);
    await expect(
      submitPairOrderExecution(
        f.db,
        'alice',
        r.authorizationId,
        consentFor(r.authorizationId, s.signature),
        signal(),
        provider().rpc,
      ),
    ).rejects.toThrow(/disabled/);
  }
  expect(
    (await readOwnedPairOrderExecution(f.db, 'alice', r.authorizationId)).state,
  ).toBe('reserved');
});

it('registers only the exact approved packet with one strict signature, immutably', async () => {
  const r = f.reserve();
  const good = f.sign();
  const other = (await import('tweetnacl')).default.sign.keyPair.fromSeed(
    new Uint8Array(32).fill(4),
  );
  const wrongKey = f.sign(other.secretKey);
  await expect(
    registerPairOrderSignature(
      f.db,
      'alice',
      r.authorizationId,
      wrongKey.signedPacket,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    registerPairOrderSignature(f.db, 'alice', r.authorizationId, f.packet),
  ).rejects.toMatchObject({ status: 400 });
  const tampered = Uint8Array.from(atob(good.signedPacket), (c) =>
    c.charCodeAt(0),
  );
  tampered[tampered.length - 1] ^= 1;
  await expect(
    registerPairOrderSignature(
      f.db,
      'alice',
      r.authorizationId,
      btoa(String.fromCharCode(...tampered)),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    registerPairOrderSignature(
      f.db,
      'bob',
      r.authorizationId,
      good.signedPacket,
    ),
  ).rejects.toMatchObject({ status: 404 });
  const saved = await registerPairOrderSignature(
    f.db,
    'alice',
    r.authorizationId,
    good.signedPacket,
  );
  expect(saved).toMatchObject({
    state: 'signed',
    signature: good.signature,
    reservationHeld: true,
  });
  // Idempotent exact resume, but no replacement signature.
  await expect(
    registerPairOrderSignature(
      f.db,
      'alice',
      r.authorizationId,
      good.signedPacket,
    ),
  ).resolves.toMatchObject({ state: 'signed' });
  await expect(
    registerPairOrderSignature(
      f.db,
      'alice',
      r.authorizationId,
      wrongKey.signedPacket,
    ),
  ).rejects.toThrow(/immutable/);
  expect(() =>
    f.sqlite.exec(`UPDATE pair_order_executions SET signature='x'`),
  ).toThrow(/Immutable/);
  expect(() => f.sqlite.exec('DELETE FROM pair_order_executions')).toThrow(
    /Immutable/,
  );
});

it('refuses registration after the signing window grace or review expiry', async () => {
  const late = f.reserve(),
    s = f.sign();
  f.sqlite.exec('DROP TRIGGER pair_order_execution_transition');
  f.sqlite
    .prepare(
      'UPDATE pair_order_executions SET authorization_expires_at=? WHERE authorization_id=?',
    )
    .run(new Date(Date.now() - 16000).toISOString(), late.authorizationId);
  await expect(
    registerPairOrderSignature(
      f.db,
      'alice',
      late.authorizationId,
      s.signedPacket,
    ),
  ).rejects.toThrow(/expired/);
  expect(
    (await readOwnedPairOrderExecution(f.db, 'alice', late.authorizationId))
      .state,
  ).toBe('reserved');
});

it('requires separate exact send consent, sends once with no retries and never resends', async () => {
  const r = await signed();
  const p = provider({ sendTransaction: () => r.signature });
  for (const bad of [
    null,
    {
      ...consentFor(r.authorizationId, r.signature),
      sendExactSignedPacketOnce: false,
    },
    { ...consentFor(r.authorizationId, r.signature), signature: 'x' },
    {
      ...consentFor(r.authorizationId, r.signature),
      packetSha256: 'a'.repeat(64),
    },
    { ...consentFor(r.authorizationId, r.signature), extra: true },
  ])
    await expect(
      submitPairOrderExecution(
        f.db,
        'alice',
        r.authorizationId,
        bad,
        signal(),
        p.rpc,
      ),
    ).rejects.toMatchObject({ status: 400 });
  expect(p.calls).toEqual([]);
  const sent = await submitPairOrderExecution(
    f.db,
    'alice',
    r.authorizationId,
    consentFor(r.authorizationId, r.signature),
    signal(),
    p.rpc,
  );
  expect(sent.state).toBe('submitted');
  const send = p.rpc.mock.calls.filter(([m]) => m === 'sendTransaction');
  expect(send).toHaveLength(1);
  expect(send[0][1]).toEqual([
    r.signedPacket,
    expect.objectContaining({
      maxRetries: 0,
      skipPreflight: false,
      encoding: 'base64',
    }),
  ]);
  await submitPairOrderExecution(
    f.db,
    'alice',
    r.authorizationId,
    consentFor(r.authorizationId, r.signature),
    signal(),
    p.rpc,
  );
  expect(
    p.rpc.mock.calls.filter(([m]) => m === 'sendTransaction'),
  ).toHaveLength(1);
  expect(() =>
    f.sqlite.exec(`UPDATE pair_order_executions SET state='signed'`),
  ).toThrow(/transition/);
});

it('records a lost or mismatched send reply as unknown and never resends it', async () => {
  for (const reply of [
    () => {
      throw Error('socket closed');
    },
    () => 'differentSignature',
  ]) {
    f.close();
    f = await pairExecutionFixture();
    const r = await signed();
    const p = provider({ sendTransaction: reply });
    const result = await submitPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      consentFor(r.authorizationId, r.signature),
      signal(),
      p.rpc,
    );
    expect(result).toMatchObject({
      state: 'submitting',
      outcome: 'unknown',
      reservationHeld: true,
    });
    await submitPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      consentFor(r.authorizationId, r.signature),
      signal(),
      p.rpc,
    );
    expect(p.calls.filter((m) => m === 'sendTransaction')).toHaveLength(1);
  }
});

it('refuses to send near the packet lifetime, on another network or unregistered', async () => {
  const unsigned = f.reserve();
  await expect(
    submitPairOrderExecution(
      f.db,
      'alice',
      unsigned.authorizationId,
      consentFor(unsigned.authorizationId, 'x'),
      signal(),
      provider().rpc,
    ),
  ).rejects.toThrow(/Register/);
  f.close();
  f = await pairExecutionFixture();
  const r = await signed();
  for (const overrides of [
    { getBlockHeight: () => '995' },
    { getGenesisHash: () => 'devnet' },
    { getBlockHeight: () => 'bad' },
  ] as Record<string, () => unknown>[]) {
    const p = provider({ ...overrides, sendTransaction: () => r.signature });
    await expect(
      submitPairOrderExecution(
        f.db,
        'alice',
        r.authorizationId,
        consentFor(r.authorizationId, r.signature),
        signal(),
        p.rpc,
      ),
    ).rejects.toThrow(/Nothing was sent/);
    expect(p.calls).not.toContain('sendTransaction');
  }
});

function receipt(
  r: { signedPacket: string },
  options: { err?: unknown; outputRaw?: string; packet?: string } = {},
) {
  return {
    slot: 500,
    transaction: [options.packet ?? r.signedPacket, 'base64'],
    meta: {
      err: options.err ?? null,
      fee: '5000',
      preBalances: ['100000000', '1'],
      postBalances: ['89995000', '1'],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: '1',
          mint: f.outputMint,
          owner: f.wallet,
          programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          uiTokenAmount: {
            amount: options.outputRaw ?? '996000',
            decimals: '8',
          },
        },
      ],
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
}
async function submitted() {
  const r = await signed();
  await submitPairOrderExecution(
    f.db,
    'alice',
    r.authorizationId,
    consentFor(r.authorizationId, r.signature),
    signal(),
    provider({ sendTransaction: () => r.signature }).rpc,
  );
  return r;
}

it('recovers an exact finalized receipt and verifies the reviewed minimum output', async () => {
  const r = await submitted();
  const p = provider({
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'finalized' }],
    }),
    getTransaction: () => receipt(r),
  });
  const result = await recoverPairOrderExecution(
    f.db,
    'alice',
    r.authorizationId,
    signal(),
    p.rpc,
  );
  expect(result).toMatchObject({
    state: 'finalized',
    reservationHeld: false,
    receipt: {
      kind: 'finalized',
      outputRaw: '996000',
      minimumOutputRaw: '995000',
      minimumOutputMet: true,
    },
  });
  expect(p.calls).not.toContain('sendTransaction');
  expect(await pairOrderReservationAvailable(f.db, 'alice', f.wallet)).toBe(
    true,
  );
});

it('flags a finalized output below the reviewed minimum and records failed receipts', async () => {
  const r = await submitted();
  expect(
    decodePairOrderReceipt(
      receipt(r, { outputRaw: '994999' }),
      (await readOwnedPairOrderExecution(
        f.db,
        'alice',
        r.authorizationId,
      )) as never,
    ),
  ).toMatchObject({ minimumOutputMet: false });
  const p = provider({
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'finalized' }],
    }),
    getTransaction: () =>
      receipt(r, { err: { InstructionError: [0, 'Custom'] } }),
  });
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      signal(),
      p.rpc,
    ),
  ).resolves.toMatchObject({
    state: 'failed',
    receipt: { kind: 'failed', minimumOutputMet: false },
  });
});

it('rejects a finalized receipt for a different packet and keeps the reservation', async () => {
  const r = await submitted();
  const p = provider({
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'finalized' }],
    }),
    getTransaction: () => receipt(r, { packet: f.packet }),
  });
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      signal(),
      p.rpc,
    ),
  ).rejects.toThrow(/differs/);
  expect(
    (await readOwnedPairOrderExecution(f.db, 'alice', r.authorizationId)).state,
  ).toBe('submitted');
});

it('leaves pending and in-lifetime unobserved packets unresolved, and expires only past finalized lifetime', async () => {
  const r = await submitted();
  const pending = provider({
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'confirmed' }],
    }),
  });
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      signal(),
      pending.rpc,
    ),
  ).resolves.toMatchObject({ state: 'submitted', reservationHeld: true });
  const inLifetime = provider({
    getSignatureStatuses: () => ({ value: [null] }),
    getBlockHeight: () => '1000',
  });
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      signal(),
      inLifetime.rpc,
    ),
  ).resolves.toMatchObject({ state: 'submitted' });
  const expired = provider({
    getSignatureStatuses: () => ({ value: [null] }),
    getBlockHeight: () => '1001',
  });
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      signal(),
      expired.rpc,
    ),
  ).resolves.toMatchObject({
    state: 'expired',
    outcome: 'expired-unobserved',
    reservationHeld: false,
    receipt: { kind: 'expired-unobserved' },
  });
  expect(expired.calls).not.toContain('sendTransaction');
});

it('releases an unsigned reservation only after the signing window grace', async () => {
  const live = f.reserve();
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      live.authorizationId,
      signal(),
      provider().rpc,
    ),
  ).resolves.toMatchObject({ state: 'reserved', reservationHeld: true });
  f.close();
  f = await pairExecutionFixture();
  // Insert is only allowed inside the window, so age it through a stub row instead.
  const r = f.reserve();
  f.sqlite.exec('DROP TRIGGER pair_order_execution_transition');
  f.sqlite
    .prepare(
      'UPDATE pair_order_executions SET authorization_expires_at=? WHERE authorization_id=?',
    )
    .run(new Date(Date.now() - 20000).toISOString(), r.authorizationId);
  await expect(
    recoverPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
      signal(),
      provider().rpc,
    ),
  ).resolves.toMatchObject({
    state: 'expired',
    reservationHeld: false,
    receipt: { kind: 'unsigned-authorization-expired' },
  });
});

it('reserves the wallet against other swaps, withdrawals and launches, and refuses conflicting reservations', async () => {
  const r = f.reserve();
  expect(await pairOrderReservationAvailable(f.db, 'alice', f.wallet)).toBe(
    false,
  );
  expect(() =>
    f.sqlite
      .prepare('INSERT INTO solana_execution_reservations VALUES (?,?,?,?,?)')
      .run('alice', f.wallet, 'withdrawal', 'w1', 'reserved'),
  ).toThrow(/stock pair/);
  expect(() =>
    f.sqlite
      .prepare('INSERT INTO pump_launch_reviews VALUES (?,?,?,?,?)')
      .run('l1', 'alice', f.wallet, 'review', '{}'),
  ).toThrow(/stock pair/);
  expect(() =>
    f.sqlite.prepare('INSERT INTO pump_launch_reviews VALUES (?,?,?,?,?)').run(
      'l2',
      'alice',
      'other',
      'review',
      JSON.stringify({
        format: 'pump-create-holders-review-v1',
        input: {
          holders: [{ address: f.wallet, kind: 'exact-base-output' }],
        },
      }),
    ),
  ).toThrow(/stock pair/);
  // Another owner is unaffected.
  f.sqlite
    .prepare('INSERT INTO solana_execution_reservations VALUES (?,?,?,?,?)')
    .run('bob', f.wallet, 'withdrawal', 'w2', 'reserved');
  // A second active reservation for the same wallet is refused.
  expect(() => f.reserve()).toThrow(/reserved|UNIQUE/);
  expect(r.authorizationId).toBeTruthy();
});

it('refuses reservation inserts whose packet, mint or owner differ from the authorization and review', async () => {
  expect(() => f.reserve({ packetOverride: 'AAAA' })).toThrow(/authorization/);
  expect(() => f.reserve({ outputMintOverride: f.inputMint })).toThrow(
    /authorization/,
  );
  expect(() => f.reserve({ authExpiresIn: -1 })).toThrow(/authorization/);
  f.sqlite
    .prepare('INSERT INTO solana_execution_reservations VALUES (?,?,?,?,?)')
    .run('alice', f.wallet, 'imported', 'i1', 'reserved');
  expect(() => f.reserve()).toThrow(/already reserved/);
});

it('never counts refunded rent from closed accounts as native SOL output', async () => {
  const r = await submitted();
  const row = {
    ...((await readOwnedPairOrderExecution(
      f.db,
      'alice',
      r.authorizationId,
    )) as object),
    output_mint: 'So11111111111111111111111111111111111111112',
    minimum_output_raw: '10000000',
  } as never;
  const native = (closedRent: boolean) => {
    const base = receipt(r);
    return {
      ...base,
      meta: {
        ...base.meta,
        // Wallet gains 9,000,000 lamports of swap output (after a 5,000 fee),
        // plus 2,039,280 rent when a pre-existing token account is closed.
        preBalances: ['100000000', closedRent ? '2039280' : '0'],
        postBalances: [
          String(100000000 + 9000000 - 5000 + (closedRent ? 2039280 : 0)),
          '0',
        ],
        postTokenBalances: [],
      },
    };
  };
  expect(decodePairOrderReceipt(native(false), row)).toMatchObject({
    outputRaw: '9000000',
    minimumOutputMet: false,
  });
  // Without the rent deduction this would read 11,039,280 and pass the minimum.
  expect(decodePairOrderReceipt(native(true), row)).toMatchObject({
    outputRaw: '9000000',
    minimumOutputMet: false,
  });
});
