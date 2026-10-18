import http from 'node:http';

const readPosts = new Set([
  '/api/wallet-workspace/warmup',
  '/api/wallet-workspace/warmup/preflight',
  '/api/wallet-workspace/warmup/quote',
  '/api/wallet-workspace/warmup/prepare',
  '/api/wallet-workspace/balances',
]);
const authPosts = new Set([
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/get-session',
  '/api/auth/solana/challenge',
  '/api/auth/solana/verify',
]);

export function allowedLocalPost(path, body) {
  const uuid = (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
  const revision = (v) => Number.isSafeInteger(v) && v >= 1 && v < 1000000000;
  const boundedPool = (v) =>
    typeof v === 'string' && /^[a-zA-Z0-9]{32,66}$/.test(v);
  const keys = (allowed, required = allowed) =>
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).every((k) => allowed.includes(k)) &&
    required.every((k) => Object.hasOwn(body, k));
  if (path === '/api/trade-amount-preferences') {
    const p = body?.preferences;
    const presetKeys = ['format', 'buySol', 'sellBalanceBps', 'sellSupplyBps'];
    const list = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 8;
    return Boolean(
      keys(['ownerId', 'preferences', 'revision']) &&
      typeof body.ownerId === 'string' &&
      body.ownerId.length >= 1 &&
      body.ownerId.length <= 128 &&
      Number.isSafeInteger(body.revision) &&
      body.revision >= 0 &&
      body.revision < 1e9 &&
      p &&
      typeof p === 'object' &&
      !Array.isArray(p) &&
      Object.keys(p).length === 4 &&
      Object.keys(p).every((k) => presetKeys.includes(k)) &&
      p.format === 'trade-amount-presets-v1' &&
      list(p.buySol) &&
      p.buySol.every(
        (v) =>
          typeof v === 'string' &&
          v.length <= 40 &&
          /^(0|[1-9]\d*)(\.\d{1,9})?$/.test(v),
      ) &&
      list(p.sellBalanceBps) &&
      list(p.sellSupplyBps) &&
      [...p.sellBalanceBps, ...p.sellSupplyBps].every(
        (n) => Number.isSafeInteger(n) && n >= 1 && n <= 10000,
      ),
    );
  }
  if (
    path === '/api/imported-projects/strategy-checks' ||
    path === '/api/imported-projects/strategy-previews'
  ) {
    const preview = path.endsWith('strategy-previews');
    return Boolean(
      keys([
        'projectId',
        'draftId',
        'revision',
        'holdId',
        ...(preview ? ['conditionPool'] : []),
      ]) &&
      uuid(body.projectId) &&
      uuid(body.draftId) &&
      uuid(body.holdId) &&
      revision(body.revision) &&
      (!preview ||
        body.conditionPool === null ||
        boundedPool(body.conditionPool)),
    );
  }
  if (path === '/api/imported-projects/market')
    return Boolean(
      keys(['id', 'revision']) && uuid(body.id) && revision(body.revision),
    );
  if (path === '/api/imported-projects/trades')
    return Boolean(
      keys(['id', 'revision', 'pool']) &&
      uuid(body.id) &&
      revision(body.revision) &&
      boundedPool(body.pool),
    );
  if (path === '/api/imported-projects/candles')
    return Boolean(
      keys(
        ['id', 'revision', 'pool', 'interval', 'currency', 'mode'],
        ['id', 'revision', 'pool', 'interval'],
      ) &&
      uuid(body.id) &&
      revision(body.revision) &&
      boundedPool(body.pool) &&
      ['1m', '5m', '1h', '1d'].includes(body.interval) &&
      (body.currency === undefined || ['sol', 'usd'].includes(body.currency)) &&
      (body.mode === undefined || ['latest', 'older'].includes(body.mode)),
    );
  if (path === '/api/wallet-workspace') {
    const wallets = body?.wallets;
    return (
      body?.action === 'wallet.add' &&
      body.chain === 'Solana' &&
      Object.keys(body).every((key) =>
        ['action', 'chain', 'folderId', 'wallets'].includes(key),
      ) &&
      (body.folderId === undefined || typeof body.folderId === 'string') &&
      Array.isArray(wallets) &&
      wallets.length === 1 &&
      wallets.every(
        (wallet) =>
          wallet &&
          typeof wallet === 'object' &&
          !Array.isArray(wallet) &&
          Object.keys(wallet).every((key) =>
            ['address', 'label', 'role', 'tags'].includes(key),
          ) &&
          (wallet.tags === undefined ||
            (Array.isArray(wallet.tags) && wallet.tags.length === 0)) &&
          typeof wallet.address === 'string' &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet.address) &&
          wallet.label === '' &&
          wallet.role === 'Recipient',
      )
    );
  }
  if (readPosts.has(path) || authPosts.has(path)) return true;
  if (path === '/api/wallet-workspace/warmup/plans')
    return body?.action === 'save';
  if (path === '/api/wallet-workspace/warmup/signing')
    return ['review', 'cancel', 'recover'].includes(body?.action);
  return false;
}

function refuse(res, status, message) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bundle-local-mode': 'no-transactions',
  });
  res.end(
    JSON.stringify({
      error: message,
      message,
      code: 'LOCAL_VERIFICATION_ONLY',
    }),
  );
}

/** The private upstream is reachable only through this exact-origin filter. */
export function localHttpsHandler({ origin, upstreamPort, edgeToken }) {
  const expected = new URL(origin);
  return async (req, res) => {
    if (
      req.headers.host !== expected.host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      !req.url?.startsWith('/') ||
      req.url.startsWith('//')
    )
      return refuse(res, 403, 'Use the exact Bundle localhost HTTPS origin.');
    const path = new URL(req.url, origin).pathname;
    let bytes = Buffer.alloc(0);
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.method !== 'POST')
        return refuse(
          res,
          403,
          'This local verification server blocks mutations.',
        );
      if (
        !req.headers['content-type']
          ?.toLowerCase()
          .startsWith('application/json')
      )
        return refuse(res, 415, 'JSON required.');
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) return refuse(res, 413, 'Request too large.');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
        const body = JSON.parse(bytes.toString('utf8'));
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          !allowedLocalPost(path, body)
        )
          return refuse(
            res,
            403,
            'Transaction registration, submission and unrelated writes are disabled on this local test origin.',
          );
      } catch {
        return refuse(res, 400, 'Valid JSON required.');
      }
    }
    const headers = {
      ...req.headers,
      host: expected.host,
      'x-forwarded-host': expected.host,
      'x-forwarded-proto': 'https',
      'x-bundle-local-edge': edgeToken,
    };
    delete headers['transfer-encoding'];
    delete headers.connection;
    if (req.method === 'POST') headers['content-length'] = String(bytes.length);
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        timeout: 120000,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, {
          ...response.headers,
          'x-bundle-local-mode': 'no-transactions',
        });
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) refuse(res, 502, 'Local application unavailable.');
      else res.destroy();
    });
    upstream.on('timeout', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    upstream.end(req.method === 'POST' ? bytes : undefined);
  };
}
