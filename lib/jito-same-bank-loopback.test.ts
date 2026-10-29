import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import bs58 from 'bs58';
import { expect, it } from 'vitest';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import { buildJitoBundleSimulationRequest } from './jito-bundle-simulation-frames';
import { collectJitoSameBankLoopback } from './jito-same-bank-loopback';

async function fixture() {
  const f = await jitoRawResponseFixture({ wallets: 2, lookup: true });
  const plan = await buildJitoBundleSimulationRequest(f.policy.packets, 101, {
    bankEncoding: 'slot-object',
    verifySignatures: false,
  });
  const response = {
    jsonrpc: '2.0',
    id: f.policy.rpcId,
    result: {
      context: f.envelope.result.context,
      value: {
        bankHash: bs58.encode(new Uint8Array(32).fill(1)),
        independentFees: plan.packetBindings.map((p) =>
          BigInt(p.expectedFeeLamports),
        ),
        packetHashes: plan.packetBindings.map((p) =>
          bs58.encode(
            createHash('sha256')
              .update(Buffer.from(p.transaction, 'base64'))
              .digest(),
          ),
        ),
        simulation: f.envelope.result.value,
      },
    },
  };
  return { f, plan, response };
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no local port');
  return `http://127.0.0.1:${address.port}/`;
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}
it('sends one exact request over loopback and retains unqualified evidence', async () => {
  const { f, plan, response } = await fixture();
  let received = '',
    count = 0;
  const server = createServer((req, res) => {
    count++;
    req.setEncoding('utf8');
    req.on('data', (v) => {
      received += v;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(f.wire(response));
    });
  });
  const endpoint = await listen(server);
  try {
    const result = await collectJitoSameBankLoopback({
      endpoint,
      packets: f.policy.packets,
      minimumSlot: 100,
      simulationBankSlot: 101,
      rpcId: f.policy.rpcId,
      signal: new AbortController().signal,
    });
    expect(count).toBe(1);
    expect(received).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        id: f.policy.rpcId,
        method: 'simulateBundleWithSameBankFees',
        params: plan.params,
      }),
    );
    expect(result.requestBody).toBe(received);
    expect(result).toMatchObject({
      requestSentByCollector: true,
      transport: 'loopback-single-request-unattested',
      bankIdentityVerified: false,
      sourceAuthenticated: false,
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  } finally {
    await stop(server);
  }
});
it('refuses nonliteral loopback URLs and slots beyond the original limit before sending', async () => {
  const { f } = await fixture();
  for (const endpoint of [
    'https://127.0.0.1:42/',
    'http://localhost:42/',
    'http://127.0.0.1:42/extra',
    'http://127.0.0.1:42/?x=1',
    'http://127.0.0.1:65536/',
    'http://127.0.0.2:42/',
  ]) {
    await expect(
      collectJitoSameBankLoopback({
        endpoint,
        packets: f.policy.packets,
        minimumSlot: 100,
        simulationBankSlot: 101,
        rpcId: f.policy.rpcId,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  }
  await expect(
    collectJitoSameBankLoopback({
      endpoint: 'http://127.0.0.1:42/',
      packets: f.policy.packets,
      minimumSlot: 68,
      simulationBankSlot: 101,
      rpcId: f.policy.rpcId,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});
it('does not follow redirects or issue a retry', async () => {
  const { f } = await fixture();
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    res.writeHead(302, { location: '/redirect' });
    res.end();
  });
  const endpoint = await listen(server);
  try {
    await expect(
      collectJitoSameBankLoopback({
        endpoint,
        packets: f.policy.packets,
        minimumSlot: 100,
        simulationBankSlot: 101,
        rpcId: f.policy.rpcId,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(count).toBe(1);
  } finally {
    await stop(server);
  }
});
it('fails closed on rate limits, malformed replies and pre-cancelled requests', async () => {
  const { f } = await fixture();
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    if (count === 1) {
      res.writeHead(429);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"jsonrpc":"2.0","jsonrpc":"2.0"}');
  });
  const endpoint = await listen(server);
  const input = {
    endpoint,
    packets: f.policy.packets,
    minimumSlot: 100,
    simulationBankSlot: 101,
    rpcId: f.policy.rpcId,
    signal: new AbortController().signal,
  };
  try {
    await expect(collectJitoSameBankLoopback(input)).rejects.toThrow();
    expect(count).toBe(1);
    await expect(collectJitoSameBankLoopback(input)).rejects.toThrow();
    expect(count).toBe(2);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      collectJitoSameBankLoopback({ ...input, signal: cancelled.signal }),
    ).rejects.toThrow();
    expect(count).toBe(2);
  } finally {
    await stop(server);
  }
});
