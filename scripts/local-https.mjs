import https from 'node:https';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { localHttpsHandler } from './local-https-guard.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tlsPort = Number(process.env.BUNDLE_LOCAL_HTTPS_PORT || 3443);
const upstreamPort = Number(process.env.BUNDLE_LOCAL_UPSTREAM_PORT || 3188);
if (
  ![tlsPort, upstreamPort].every(
    (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
  ) ||
  tlsPort === upstreamPort
)
  throw new Error('Choose two distinct unprivileged local ports.');
if (!existsSync(new URL('../.next/BUILD_ID', import.meta.url)))
  throw new Error('Build the Desktop checkout before starting local HTTPS.');
const origin = `https://localhost:${tlsPort}`;
const passphrase = process.env.BUNDLE_LOCAL_TLS_PASSPHRASE;
if (!passphrase) throw new Error('Start with scripts/start-local-https.ps1.');
const pfx = readFileSync(
  new URL('../work/local-https/localhost.pfx', import.meta.url),
);
delete process.env.BUNDLE_LOCAL_TLS_PASSPHRASE;
process.env.NODE_ENV = 'production';
process.env.BETTER_AUTH_URL = origin;
const next = (await import('next')).default;
// Advertise the actual public TLS origin, not the private upstream port.
const app = next({
  dev: false,
  dir: root,
  hostname: 'localhost',
  port: tlsPort,
});
await app.prepare();
const handle = app.getRequestHandler();
const edgeToken = randomBytes(32).toString('hex');
const upstream = http.createServer((req, res) => {
  if (req.headers['x-bundle-local-edge'] !== edgeToken) {
    res.writeHead(403);
    res.end('Local TLS edge required.');
    return;
  }
  delete req.headers['x-bundle-local-edge'];
  return handle(req, res);
});
const server = https.createServer(
  { pfx, passphrase, minVersion: 'TLSv1.2' },
  localHttpsHandler({ origin, upstreamPort, edgeToken }),
);
async function listen(target, port) {
  await new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(port, '127.0.0.1', resolve);
  });
}
try {
  await listen(upstream, upstreamPort);
  await listen(server, tlsPort);
} catch {
  upstream.close();
  server.close();
  await app.close();
  throw new Error('Local HTTPS ports are unavailable.');
}
console.log(`Bundle verification: ${origin}`);
console.log(
  'NO TRANSACTIONS: registration/submission and unrelated writes are blocked. Wallet sign-in and saving one public Solana wallet are allowed. Never sign trade transactions.',
);
const close = async () => {
  server.close();
  upstream.close();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
