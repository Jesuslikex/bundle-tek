import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { allowedLocalPost, localHttpsHandler } from './local-https-guard.mjs';

await test('admits only bounded manual market observations and unsigned strategy inspection', () => {
  const id = '00000000-0000-4000-8000-000000000001',
    pool = '11111111111111111111111111111111';
  const calls = [
    ['market', { id, revision: 1 }],
    ['trades', { id, revision: 1, pool }],
    ['candles', { id, revision: 1, pool, interval: '1m' }],
    [
      'strategy-checks',
      { projectId: id, draftId: id, revision: 1, holdId: id },
    ],
    [
      'strategy-previews',
      {
        projectId: id,
        draftId: id,
        revision: 1,
        holdId: id,
        conditionPool: null,
      },
    ],
  ];
  for (const [name, body] of calls) {
    const path =
      '/api/imported-projects/' + (typeof name === 'string' ? name : '');
    assert.equal(allowedLocalPost(path, body), true);
    for (const changed of [
      { ...body, action: 'submit' },
      { ...body, transaction: 'packet' },
      { ...body, revision: 0 },
      { ...body, revision: 1e9 },
      {},
    ])
      assert.equal(allowedLocalPost(path, changed), false);
  }
  const path = '/api/imported-projects/candles',
    base = { id, revision: 1, pool, interval: '1h' };
  assert.equal(
    allowedLocalPost(path, { ...base, mode: 'older', currency: 'sol' }),
    true,
  );
  for (const changed of [
    { ...base, mode: 'follow' },
    { ...base, interval: '10m' },
    { ...base, pool: 'https://provider.invalid' },
    { ...base, currency: 'eur' },
  ])
    assert.equal(allowedLocalPost(path, changed), false);
});

await test('allows only warmup review actions, never packet registration or submission', () => {
  const path = '/api/wallet-workspace/warmup/signing';
  for (const action of ['review', 'cancel', 'recover'])
    assert.equal(allowedLocalPost(path, { action }), true);
  for (const action of ['register', 'submit', '', null, undefined])
    assert.equal(allowedLocalPost(path, { action }), false);
  for (const endpoint of ['challenge', 'verify'])
    assert.equal(allowedLocalPost(`/api/auth/solana/${endpoint}`, {}), true);
  for (const target of [
    '/api/launch/pump/groups',
    '/api/imported-projects/swaps',
    '/api/wallet-workspace/withdrawals',
    '/api/wallet-workspace',
  ])
    assert.equal(allowedLocalPost(target, { action: 'submit' }), false);
  assert.equal(
    allowedLocalPost('/api/wallet-workspace/warmup/plans', { action: 'save' }),
    true,
  );
  assert.equal(
    allowedLocalPost('/api/wallet-workspace/warmup/plans', {
      action: 'archive',
    }),
    false,
  );
});

await test('real HTTP forwarding preserves auth headers and blocks forbidden requests before upstream', async () => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, {
      'set-cookie': 'fixture=session; Secure; HttpOnly; SameSite=Lax',
    });
    res.end('ok');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const edge = http.createServer(
    localHttpsHandler({
      origin: 'https://localhost:3443',
      upstreamPort: upstream.address().port,
      edgeToken: 'fixture-edge-token',
    }),
  );
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const request = (
    path,
    {
      method = 'POST',
      host = 'localhost:3443',
      origin = 'https://localhost:3443',
      body = '{}',
      contentType = 'application/json',
    } = {},
  ) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: edge.address().port,
          path,
          method,
          headers: {
            host,
            origin,
            'content-type': contentType,
            cookie: 'fixture-cookie=synthetic',
            'x-forwarded-proto': 'http',
            'x-bundle-local-edge': 'attacker-supplied',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });
  try {
    const signedOut = await request('/api/auth/get-session', { method: 'GET' });
    assert.equal(signedOut.status, 200);
    assert.match(signedOut.headers['set-cookie'][0], /Secure; HttpOnly/);
    assert.equal(seen[0].headers.cookie, 'fixture-cookie=synthetic');
    assert.equal(seen[0].headers['x-forwarded-proto'], 'https');
    assert.equal(seen[0].headers['x-bundle-local-edge'], 'fixture-edge-token');
    const review = await request('/api/wallet-workspace/warmup/signing', {
      body: '{"action":"review"}',
    });
    assert.equal(review.status, 200);
    assert.equal(seen[1].body, '{"action":"review"}');
    const login = await request('/api/auth/sign-in/email', {
      body: '{"email":"fixture@example.invalid","password":"synthetic"}',
    });
    assert.equal(login.status, 200);
    const signup = await request('/api/auth/sign-up/email', {
      body: '{"name":"Fixture","email":"fixture@example.invalid","password":"synthetic"}',
    });
    assert.equal(signup.status, 200);
    assert.equal(seen[3].path, '/api/auth/sign-up/email');
    for (const action of ['register', 'submit']) {
      const refused = await request('/api/wallet-workspace/warmup/signing', {
        body: JSON.stringify({ action }),
      });
      assert.equal(refused.status, 403);
      assert.match(refused.body, /LOCAL_VERIFICATION_ONLY/);
      assert.equal(typeof JSON.parse(refused.body).message, 'string');
    }
    assert.equal(
      (await request('/api/wallet-workspace/withdrawals')).status,
      403,
    );
    assert.equal(
      (await request('/api/auth/sign-in/email', { host: 'evil.example' }))
        .status,
      403,
    );
    assert.equal(
      (
        await request('/api/auth/sign-in/email', {
          origin: 'https://evil.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (await request('/api/auth/sign-in/email', { contentType: 'text/plain' }))
        .status,
      415,
    );
    assert.equal(
      (await request('/api/auth/sign-in/email', { body: 'null' })).status,
      403,
    );
    assert.equal(
      (await request('/api/auth/sign-in/email', { body: '{' })).status,
      400,
    );
    assert.equal(
      (await request('/api/auth/sign-in/email', { method: 'DELETE' })).status,
      403,
    );
    assert.equal(
      (
        await request('/api/auth/sign-in/email', {
          body: JSON.stringify({ oversized: 'x'.repeat(66000) }),
        })
      ).status,
      413,
    );
    assert.equal(seen.length, 4);
    const id = '00000000-0000-4000-8000-000000000001',
      pool = '11111111111111111111111111111111';
    for (const [name, body] of [
      ['market', { id, revision: 1 }],
      ['trades', { id, revision: 1, pool }],
      ['candles', { id, revision: 1, pool, interval: '1m', mode: 'older' }],
      [
        'strategy-checks',
        { projectId: id, draftId: id, revision: 1, holdId: id },
      ],
      [
        'strategy-previews',
        {
          projectId: id,
          draftId: id,
          revision: 1,
          holdId: id,
          conditionPool: null,
        },
      ],
    ]) {
      const path =
        '/api/imported-projects/' + (typeof name === 'string' ? name : '');
      assert.equal(
        (await request(path, { body: JSON.stringify(body) })).status,
        200,
      );
      const before = seen.length;
      assert.equal(
        (
          await request(path, {
            body: JSON.stringify({ ...body, action: 'submit' }),
          })
        ).status,
        403,
      );
      assert.equal(seen.length, before);
    }
    assert.equal(
      (
        await request('/api/imported-projects/candles', {
          body: JSON.stringify({
            id,
            revision: 1,
            pool,
            interval: '1m',
            mode: 'follow',
          }),
        })
      ).status,
      403,
    );
    assert.equal(seen.length, 9);
  } finally {
    await Promise.all([
      new Promise((resolve) => edge.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});

await test('allows one public Solana wallet while refusing bulk, secret fields and other writes', () => {
  const path = '/api/wallet-workspace';
  const body = {
    action: 'wallet.add',
    chain: 'Solana',
    folderId: '',
    wallets: [
      {
        address: '11111111111111111111111111111111',
        label: '',
        role: 'Recipient',
      },
    ],
  };
  assert.equal(allowedLocalPost(path, body), true);
  assert.equal(
    allowedLocalPost(path, {
      ...body,
      wallets: [{ ...body.wallets[0], tags: [] }],
    }),
    true,
  );
  for (const changed of [
    { ...body, chain: 'Ethereum' },
    { ...body, action: 'wallet.delete' },
    { ...body, privateKey: 'fixture' },
    { ...body, wallets: [...body.wallets, ...body.wallets] },
    { ...body, wallets: [{ ...body.wallets[0], privateKey: 'fixture' }] },
    { ...body, wallets: [{ ...body.wallets[0], tags: ['unexpected'] }] },
    { ...body, wallets: [{ ...body.wallets[0], tags: 'unexpected' }] },
    { ...body, wallets: [{ ...body.wallets[0], address: '1'.repeat(88) }] },
  ])
    assert.equal(allowedLocalPost(path, changed), false);
});
