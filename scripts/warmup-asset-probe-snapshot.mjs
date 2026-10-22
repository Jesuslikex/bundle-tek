import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readHash = (file) => {
  try {
    return digest(readFileSync(file));
  } catch {
    return null;
  }
};
const entry =
  "export {inspectWarmupExecutionAssets} from './lib/wallet-warmup-execution-assets';export {warmupPublicAssetReviewFixture} from './test/warmup-public-asset-review-fixture';";
/** Freeze the exact bytes esbuild consumes and a private copy of the original
 * migrations. No environment file, credentials or application database copied. */
export async function snapshotWarmupAssetProbe(root, folder) {
  const sourceFiles = {},
    frozenFiles = {};
  const virtual = 'public-warmup-asset-reader.ts';
  const bundle = join(folder, 'reader.mjs');
  const tsconfig = readFileSync(join(root, 'tsconfig.json'));
  sourceFiles['tsconfig.json'] = digest(tsconfig);
  const built = await build({
    tsconfigRaw: tsconfig.toString('utf8'),
    stdin: { contents: entry, resolveDir: root, sourcefile: virtual },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    outfile: bundle,
    logLevel: 'silent',
    plugins: [
      {
        name: 'exact-probe-source-bytes',
        setup(builder) {
          builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, (args) => {
            const bytes = readFileSync(args.path);
            const name = relative(root, args.path).replaceAll('\\', '/');
            if (name.startsWith('../') || name.startsWith('.env'))
              throw Error('Probe source is outside its allowed repository.');
            sourceFiles[name] = digest(bytes);
            const extension = extname(args.path);
            const loader =
              extension === '.json'
                ? 'json'
                : extension === '.tsx'
                  ? 'tsx'
                  : extension === '.jsx'
                    ? 'jsx'
                    : ['.ts', '.mts', '.cts'].includes(extension)
                      ? 'ts'
                      : 'js';
            return { contents: bytes, loader, resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const realInputs = Object.keys(built.metafile.inputs).filter(
    (name) => name !== virtual && name !== '<stdin>',
  );
  if (realInputs.some((name) => !sourceFiles[name.replaceAll('\\', '/')]))
    throw Error('An input was not captured by the probe source reader.');
  const journalBytes = readFileSync(join(root, 'drizzle/meta/_journal.json'));
  const journal = JSON.parse(journalBytes.toString('utf8'));
  const schema = [
    'drizzle/meta/_journal.json',
    ...journal.entries.map((row) => 'drizzle/' + row.tag + '.sql'),
  ];
  for (const name of schema) {
    const bytes =
      name === 'drizzle/meta/_journal.json'
        ? journalBytes
        : readFileSync(join(root, name));
    sourceFiles[name] = digest(bytes);
    frozenFiles[name] = digest(bytes);
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), bytes);
  }
  for (const name of [
    'package.json',
    'package-lock.json',
    'scripts/qualify-warmup-execution-assets.mjs',
    'scripts/warmup-asset-probe-policy.mjs',
    'scripts/warmup-asset-probe-snapshot.mjs',
  ])
    sourceFiles[name] = digest(readFileSync(join(root, name)));
  writeFileSync(join(folder, virtual), entry);
  frozenFiles[virtual] = digest(entry);
  frozenFiles['reader.mjs'] = digest(readFileSync(bundle));
  return {
    root,
    folder,
    bundle,
    sourceFiles,
    frozenFiles,
    migrations: journal.entries.length,
  };
}
export function verifyWarmupAssetProbeSnapshot(snapshot) {
  return {
    sourceUnchanged: Object.entries(snapshot.sourceFiles).every(
      ([file, hash]) => readHash(resolve(snapshot.root, file)) === hash,
    ),
    snapshotUnchanged: Object.entries(snapshot.frozenFiles).every(
      ([file, hash]) => readHash(resolve(snapshot.folder, file)) === hash,
    ),
  };
}
