import http from 'node:http';

const readPosts = new Set([
  '/api/wallet-workspace/warmup',
  '/api/wallet-workspace/warmup/preflight',
  '/api/wallet-workspace/warmup/quote',
  '/api/wallet-workspace/warmup/prepare',
  '/api/wallet-workspace/balances',
]);
const authPosts = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/get-session',
  '/api/auth/solana/challenge',
  '/api/auth/solana/verify',
]);

export function allowedLocalPost(path, body) {
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
  res.end(JSON.stringify({ error: message, code: 'LOCAL_VERIFICATION_ONLY' }));
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
