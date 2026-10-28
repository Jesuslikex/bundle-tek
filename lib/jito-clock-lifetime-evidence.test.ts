import { expect, it, vi } from 'vitest';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';
import { jitoOwnerScope } from './jito-owner-scope';
import { bundleFingerprint } from './jito-bundle';
import { PAIR_CLOCK } from './pair-stock-clock';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { inspectJitoClockLifetimeEvidence } from './jito-clock-lifetime-evidence';
import * as rawParser from './jito-simulation-json';

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const capture = (
  id: string,
  method: string,
  params: unknown[],
  result: unknown,
) => ({
  request: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  response: bytes({ jsonrpc: '2.0', id, result }),
});
async function fixture() {
  const f = await jitoBundleFixture();
  const m = f.manifest;
  const scope = await jitoOwnerScope('alice');
  const vals = [f.swap.signed, f.tip.signed];
  const attempts = vals.map((value, packet) => ({
    bundleId: m.id,
    packet,
    attemptId: crypto.randomUUID(),
    manifestSha256: m.sha256,
    signer: m.swaps[packet]?.wallet ?? m.tip.wallet,
    intentId: m.swaps[packet]?.id ?? null,
    transaction: value.transaction,
    signature: value.signature,
    state: 'registered',
  }));
  const rawSnapshot = {
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundle: {
      manifest: m,
      state: 'reviewed',
      bundleId: null,
      signatures: vals.map((v) => v.signature),
      updatedAt: m.createdAt,
      finalization: null,
    },
    attempts,
    legacyReadOnly: false,
  };
  const min = m.tip.slot,
    clockSlot = min + 1,
    now = Date.now(),
    unix = String(Math.floor(now / 1000));
  const blockhashes = vals.map((value) =>
    String(
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(Buffer.from(value.transaction, 'base64'))
          .messageBytes,
      ).lifetimeToken,
    ),
  );
  const last = [
    ...m.swaps.map((s) => BigInt(s.lastValidBlockHeight)),
    BigInt(m.tip.lastValidBlockHeight),
  ];
  const height = Number(last.reduce((a, b) => (a < b ? a : b)) - 1n);
  const account = {
    ...pairQuoteClock(clockSlot, unix),
    lamports: 1,
    rentEpoch: 0,
  };
  const context = { slot: clockSlot };
  const input = {
    rawSnapshot,
    ownerId: 'alice',
    responseOwnerScope: scope,
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundleId: m.id,
    manifestSha256: m.sha256,
    originalMinimumSlot: min,
    latestFloor: min,
    beforeGenesis: capture(
      'jito-genesis-before',
      'getGenesisHash',
      [],
      SOLANA_MAINNET_GENESIS,
    ),
    clock: capture(
      'jito-clock',
      'getMultipleAccounts',
      [
        [PAIR_CLOCK, PAIR_CLOCK],
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: min },
      ],
      { context, value: [account, account] },
    ),
    height: capture(
      'jito-height',
      'getBlockHeight',
      [{ commitment: 'finalized', minContextSlot: clockSlot }],
      height,
    ),
    validity: blockhashes.map((hash, index) =>
      capture(
        `jito-valid:${index}`,
        'isBlockhashValid',
        [hash, { commitment: 'finalized', minContextSlot: clockSlot }],
        { context, value: true },
      ),
    ),
    finalHeight: capture(
      'jito-height-final',
      'getBlockHeight',
      [{ commitment: 'finalized', minContextSlot: clockSlot }],
      height,
    ),
    afterGenesis: capture(
      'jito-genesis-after',
      'getGenesisHash',
      [],
      SOLANA_MAINNET_GENESIS,
    ),
  };
  return { f, input, account, clockSlot, min, height, blockhashes, now };
}
const run = (
  value: Awaited<ReturnType<typeof fixture>>['input'],
  signal = new AbortController().signal,
) => inspectJitoClockLifetimeEvidence(value, signal);
const change = (
  capture: { response: Uint8Array },
  // Synthetic malformed RPC envelopes intentionally vary the result shape.
  // oxlint-disable-next-line typescript/no-explicit-any
  edit: (value: any) => void,
) => {
  const parsed = JSON.parse(new TextDecoder().decode(capture.response));
  edit(parsed);
  capture.response = bytes(parsed);
};
it('decodes exact equal Clock, network, blockhash and conservative lifetime without granting source or execution authority', async () => {
  const f = await fixture();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    const result = await run(f.input);
    expect(result.clockSlot).toBe(f.clockSlot);
    expect(result.blockHeight).toBe(String(f.height));
    expect(result).toMatchObject({
      sourceAuthenticated: false,
      networkVerified: false,
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
it('refuses Clock +1 or behind, different duplicates, wrong owner and malformed account', async () => {
  for (const mutation of [
    'ahead',
    'behind',
    'duplicate',
    'owner',
    'layout',
  ] as const) {
    const f = await fixture();
    change(f.input.clock, (v) => {
      const a = v.result.value[0];
      if (mutation === 'ahead')
        a.data = pairQuoteClock(
          f.clockSlot + 1,
          String(Math.floor(f.now / 1000)),
        ).data;
      if (mutation === 'behind')
        a.data = pairQuoteClock(
          f.clockSlot - 1,
          String(Math.floor(f.now / 1000)),
        ).data;
      if (mutation === 'duplicate') v.result.value[1].lamports = 2;
      if (mutation === 'owner') {
        v.result.value[0].owner = '11111111111111111111111111111111';
        v.result.value[1].owner = v.result.value[0].owner;
      }
      if (mutation === 'layout') {
        v.result.value[0].data = ['AA==', 'base64'];
        v.result.value[1].data = v.result.value[0].data;
      }
      if (mutation === 'ahead' || mutation === 'behind')
        v.result.value[1].data = a.data;
    });
    await expect(run(f.input)).rejects.toThrow();
  }
});
it('enforces 30-second Clock drift at the boundary', async () => {
  const f = await fixture();
  const exact = Math.floor(f.now / 1000) * 1000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(exact + 30000);
  try {
    await expect(run(f.input)).resolves.toBeTruthy();
    now.mockReturnValue(exact + 30001);
    await expect(run(f.input)).rejects.toThrow();
  } finally {
    now.mockRestore();
  }
});
it('accepts the original 32-slot boundary and refuses a 33-slot span', async () => {
  const f = await fixture();
  const clock = f.clockSlot;
  const target = f.min + 32;
  change(f.input.validity[0], (v) => {
    v.result.context.slot = target;
  });
  f.input.validity[1].request = JSON.stringify({
    jsonrpc: '2.0',
    id: 'jito-valid:1',
    method: 'isBlockhashValid',
    params: [
      f.blockhashes[1],
      { commitment: 'finalized', minContextSlot: target },
    ],
  });
  change(f.input.validity[1], (v) => {
    v.result.context.slot = target;
  });
  f.input.finalHeight.request = JSON.stringify({
    jsonrpc: '2.0',
    id: 'jito-height-final',
    method: 'getBlockHeight',
    params: [{ commitment: 'finalized', minContextSlot: target }],
  });
  expect((await run(f.input)).maximumSlot).toBe(target);
  change(f.input.validity[0], (v) => {
    v.result.context.slot = f.min + 33;
  });
  await expect(run(f.input)).rejects.toThrow();
  expect(clock).toBe(f.clockSlot);
});
it('refuses wrong network, exact request rebinding, duplicate keys, stale floors and invalid blockhashes', async () => {
  for (const mutation of [
    'genesis',
    'request',
    'duplicate',
    'floor',
    'invalid',
    'height',
    'final-height',
  ] as const) {
    const f = await fixture();
    if (mutation === 'genesis')
      change(f.input.afterGenesis, (v) => {
        v.result = 'wrong-network';
      });
    if (mutation === 'request')
      f.input.validity[0].request = f.input.validity[1].request;
    if (mutation === 'duplicate')
      f.input.beforeGenesis.response = new TextEncoder().encode(
        '{"jsonrpc":"2.0","id":"jito-genesis-before","result":"x","result":"x"}',
      );
    if (mutation === 'floor')
      change(f.input.validity[0], (v) => {
        v.result.context.slot = f.clockSlot - 1;
      });
    if (mutation === 'invalid')
      change(f.input.validity[0], (v) => {
        v.result.value = false;
      });
    if (mutation === 'height')
      change(f.input.height, (v) => {
        v.result = f.height + 1;
      });
    if (mutation === 'final-height')
      change(f.input.finalHeight, (v) => {
        v.result = f.height - 1;
      });
    await expect(run(f.input)).rejects.toThrow();
  }
});
it('detaches untrusted input before async work and refuses an aborted inspection', async () => {
  const f = await fixture();
  const pending = run(f.input);
  f.input.clock.response.fill(0);
  f.input.ownerId = 'bob';
  expect((await pending).sourceAuthenticated).toBe(false);
  const g = await fixture();
  const controller = new AbortController();
  const interrupted = run(g.input, controller.signal);
  controller.abort();
  await expect(interrupted).rejects.toThrow();
});
it('rejects shared-backed buffers, oversized captures, excessive counts and accessors before awaiting', async () => {
  const shared = await fixture();
  shared.input.clock.response = new Uint8Array(
    new SharedArrayBuffer(64),
  ) as unknown as typeof shared.input.clock.response;
  await expect(run(shared.input)).rejects.toThrow();
  const huge = await fixture();
  huge.input.clock.response = new Uint8Array(65537);
  await expect(run(huge.input)).rejects.toThrow();
  const request = await fixture();
  request.input.clock.request = 'x'.repeat(32769);
  await expect(run(request.input)).rejects.toThrow();
  const many = await fixture();
  many.input.validity = Array.from({ length: 6 }, () => many.input.validity[0]);
  await expect(run(many.input)).rejects.toThrow();
  const accessor = await fixture();
  let invoked = false;
  Object.defineProperty(accessor.input.clock, 'response', {
    enumerable: true,
    get() {
      invoked = true;
      return new Uint8Array(4);
    },
  });
  await expect(run(accessor.input)).rejects.toThrow();
  expect(invoked).toBe(false);
});
it.each(['clock-expiry', 'abort'] as const)(
  'refuses %s during the final raw response parse',
  async (reason) => {
    const f = await fixture();
    const controller = new AbortController();
    const original = rawParser.readJitoSimulationPayload;
    let calls = 0,
      started!: () => void,
      release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(rawParser, 'readJitoSimulationPayload').mockImplementation(
      async (...args) => {
        const value = await original(...args);
        if (++calls === 7) {
          started();
          await blocked;
        }
        return value;
      },
    );
    const now = vi.spyOn(Date, 'now');
    try {
      const pending = run(f.input, controller.signal);
      await began;
      if (reason === 'abort') controller.abort();
      else now.mockReturnValue(f.now + 31000);
      release();
      await expect(pending).rejects.toThrow();
    } finally {
      now.mockRestore();
      vi.restoreAllMocks();
    }
  },
);
it('refuses approval expiry during the last parse even when Clock drift remains inside its bound', async () => {
  const f = await fixture();
  const m = f.input.rawSnapshot.bundle.manifest;
  m.expiresAt = new Date(f.now + 5000).toISOString();
  const { sha256: _previous, ...terms } = m;
  m.sha256 = await bundleFingerprint(terms);
  f.input.manifestSha256 = m.sha256;
  for (const attempt of f.input.rawSnapshot.attempts)
    attempt.manifestSha256 = m.sha256;
  const original = rawParser.readJitoSimulationPayload;
  let count = 0,
    started!: () => void,
    release!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(rawParser, 'readJitoSimulationPayload').mockImplementation(
    async (...args) => {
      const value = await original(...args);
      if (++count === 7) {
        started();
        await blocked;
      }
      return value;
    },
  );
  const now = vi.spyOn(Date, 'now');
  try {
    const pending = run(f.input);
    await began;
    now.mockReturnValue(f.now + 6000);
    release();
    await expect(pending).rejects.toThrow();
  } finally {
    now.mockRestore();
    vi.restoreAllMocks();
  }
});
