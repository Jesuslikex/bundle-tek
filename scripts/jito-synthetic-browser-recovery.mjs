/** Local-only synthetic browser journal harness. Does not use real credentials,
 * wallets, providers or transaction submission. Run from the repository root. */
import { build } from 'vite';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep, extname, dirname, basename } from 'node:path';
import {
  newSyntheticHost,
  acceptsSyntheticHost,
} from './jito-synthetic-browser-guard.mjs';

const host = newSyntheticHost();
const runId = newSyntheticHost();
const root = resolve('test/jito-browser-recovery');
const fixture = resolve(root, 'fixture.json');
const tempRoot = await realpath(tmpdir());
const out = await mkdtemp(resolve(tempRoot, 'bundle-jito-browser-'));
/** @type {{server: import('node:http').Server | null}} */
const runtime = { server: null };
let stopping = false;
async function removeOwnOutput() {
  // Only remove the exact, real directory this process created directly below
  // the resolved temp root. Never enumerate or remove older temp directories.
  const info = await lstat(out);
  const actual = await realpath(out);
  const equal = (a, b) =>
    process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !equal(actual, out) ||
    !equal(dirname(actual), tempRoot) ||
    !/^bundle-jito-browser-[A-Za-z0-9]{6}$/.test(basename(actual))
  )
    throw Error('Test output path verification failed; output was retained.');
  await rm(actual, { recursive: true, force: false });
}
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (runtime.server?.listening)
    await new Promise((done) => runtime.server.close(done));
  try {
    await removeOwnOutput();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Test output cleanup failed.',
    );
    exitCode = 1;
  }
  process.exitCode = exitCode;
  process.stdin.pause();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.trim() === 'quit') void stop();
});
try {
  const vector = JSON.parse(await readFile(fixture, 'utf8'));
  if (
    typeof vector.signed !== 'string' ||
    !vector.manifest ||
    typeof vector.signature !== 'string'
  )
    throw Error('Synthetic vector unavailable.');
  await build({
    configFile: false,
    define: { __JITO_SYNTHETIC_RUN_ID__: JSON.stringify(runId) },
    root,
    publicDir: false,
    logLevel: 'error',
    resolve: {
      alias: { '@jito-synthetic-vector': fixture, '@': resolve('.') },
    },
    build: {
      outDir: out,
      emptyOutDir: false,
      rolldownOptions: {
        input: {
          main: resolve(root, 'index.html'),
          peer: resolve(root, 'peer.html'),
        },
      },
    },
  });
} catch (error) {
  console.error('Synthetic harness build failed.');
  await stop(1);
  throw error;
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
runtime.server = createServer(async (request, response) => {
  const address = runtime.server.address();
  if (
    !address ||
    typeof address === 'string' ||
    !acceptsSyntheticHost(
      request.headers.host,
      address.port,
      request.socket.remoteAddress,
      host,
    )
  ) {
    response.writeHead(403).end();
    return;
  }
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'",
  );
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  try {
    const path = decodeURIComponent(
      new URL(request.url, 'http://127.0.0.1').pathname,
    );
    const target = resolve(out, '.' + (path === '/' ? '/index.html' : path));
    if (!target.startsWith(out + sep)) throw Error('outside output');
    const content = await readFile(target);
    response
      .writeHead(200, {
        'Content-Type': mime[extname(target)] ?? 'application/octet-stream',
      })
      .end(content);
  } catch {
    response.writeHead(404).end();
  }
});
runtime.server.listen(0, '127.0.0.1', () =>
  console.log(
    `Synthetic test ready: http://${host}:${runtime.server.address().port}/`,
  ),
);
