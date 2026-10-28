import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { collectJitoCoherentPrefeeAttempt } from '../lib/jito-coherent-prefee-attempt';

// This is a single historical native-transfer capture, not a current provider
// observation or a swap. Exact digests bind the private ignored files without
// printing any request, response, address, transaction, URL or credential.
const files = {
  'input-private.json': [
    892,
    '602f654954fa8169cac194ee4c24d6287f011d4d2c213cb67ab303160d74858c',
  ],
  'outcome.json': [
    4296,
    'a1bd7b732deaeabd3106800c8e3772bc39c81ed76ab65f5ec62c608c0168a6b7',
  ],
  '3.request.json': [
    2239,
    '39935c47067db020fde81d5fac10cf5677336cb814e3154a439bc9832fb4ab15',
  ],
  '3.response.bin': [
    3312,
    'd750079c3ad2ca1b9799aeb292fbb9855c734129add183bd6f23af5cfa33cd61',
  ],
  '4.request.json': [
    1530,
    'a62130dd3f8d17d25c51d2fd10f7c9d8e2c9f700c82ce14e2eff25855cdb62cc',
  ],
  '4.response.bin': [
    3068,
    '7ea85d20c35ec5bf975c18ca5a3bd2301a219e7cc4eabfa0148591441659986e',
  ],
} as const;
const path = process.env.JITO_PREFEE_REPLAY_DIR;
const localDriveForm = (candidate: string) => /^[A-Za-z]:[\\/]/.test(candidate);
const sameDrive = (a: string, b: string) =>
  localDriveForm(a) &&
  localDriveForm(b) &&
  a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();
function check(condition: unknown): asserts condition {
  if (!condition)
    throw Error(
      'Offline replay refused: retained evidence or reconstructed request differs.',
    );
}

async function localEvidenceDirectory(candidate: string): Promise<string> {
  // This fixture belongs to the worktree's drive. Reject UNC/device forms
  // before looking them up, and reject junctions in every directory component.
  // These checks are not an OS network sandbox and cannot prove a drive is not
  // mapped or prevent a directory from being swapped after it is inspected.
  check(
    process.platform === 'win32' &&
      candidate.length <= 4096 &&
      localDriveForm(candidate),
  );
  const absolute = resolve(candidate),
    base = resolve(process.cwd(), 'work', 'release-qa');
  check(localDriveForm(base));
  const worktree = resolve(process.cwd());
  check(localDriveForm(worktree));
  const within = (parent: string, child: string) => {
    const r = relative(parent, child);
    return !!r && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
  };
  check(within(base, absolute));
  const root = parse(absolute).root;
  check(/^[A-Za-z]:[\\/]$/.test(root));
  check(sameDrive(root, parse(worktree).root));
  let cursor = root;
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    cursor = join(cursor, part);
    const entry = await lstat(cursor);
    check(entry.isDirectory() && !entry.isSymbolicLink());
  }
  const canonicalWorktree = await realpath(worktree),
    canonicalBase = await realpath(base),
    canonical = await realpath(absolute);
  check(
    localDriveForm(canonicalWorktree) &&
      localDriveForm(canonicalBase) &&
      localDriveForm(canonical) &&
      within(canonicalBase, canonical),
  );
  check(sameDrive(parse(canonical).root, parse(canonicalWorktree).root));
  check(resolve(canonical).toLowerCase() === absolute.toLowerCase());
  return canonical;
}

async function readBounded(
  directory: string,
  name: keyof typeof files,
): Promise<Buffer> {
  const [size, sha256] = files[name];
  const file = join(directory, name);
  const link = await lstat(file);
  check(link.isFile() && !link.isSymbolicLink() && link.size === size);
  const handle = await open(file, 'r');
  try {
    const actual = await handle.stat();
    check(actual.isFile() && actual.size === size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        size - offset,
        offset,
      );
      check(bytesRead > 0);
      offset += bytesRead;
    }
    check(createHash('sha256').update(bytes).digest('hex') === sha256);
    return bytes;
  } finally {
    await handle.close();
  }
}

it('rejects UNC and device forms and compares drive letters lexically', () => {
  expect(localDriveForm('\\\\server\\share\\fixture')).toBe(false);
  expect(localDriveForm('\\\\?\\UNC\\server\\share\\fixture')).toBe(false);
  expect(localDriveForm('//server/share/fixture')).toBe(false);
  expect(localDriveForm('Z:\\fixture')).toBe(true);
  expect(localDriveForm('C:\\fixture')).toBe(true);
  expect(sameDrive('C:\\workspace', 'c:\\fixture')).toBe(true);
  expect(sameDrive('C:\\workspace', 'Z:\\fixture')).toBe(false);
  expect(sameDrive('C:\\workspace', '\\\\server\\share')).toBe(false);
});

it.skipIf(!path)(
  'replays one retained native Jito attempt with an in-memory transport',
  async () => {
    // Stub global fetch as defense in depth; the tested collector receives only
    // the in-memory transport below. This is not an OS network sandbox.
    vi.stubGlobal('fetch', () => {
      throw Error('Global fetch disabled in retained replay.');
    });
    let stage = 'files';
    try {
      check(typeof path === 'string' && path.length > 0);
      const directory = await localEvidenceDirectory(path);
      const [
        inputBytes,
        outcomeBytes,
        request3,
        response3,
        request4,
        response4,
      ] = await Promise.all(
        (Object.keys(files) as (keyof typeof files)[]).map((name) =>
          readBounded(directory, name),
        ),
      );
      type Packet = Parameters<
        typeof collectJitoCoherentPrefeeAttempt
      >[0]['packets'];
      const original = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(inputBytes),
      ) as {
        packets: Packet;
        originalFloor: number;
        accountSlot: number;
      };
      const outcome = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(outcomeBytes),
      ) as {
        index: number;
        status: string;
        nativeCaptured: boolean;
        bank: number;
        signingAllowed: boolean;
        executionAllowed: boolean;
        providerQualified: boolean;
        reads: {
          requestSha256?: string;
          responseSha256?: string;
          httpStatus?: number;
        }[];
      };
      stage = 'record';
      check(
        outcome.index === 2 &&
          outcome.status === 'captured' &&
          outcome.nativeCaptured === true,
      );
      check(
        outcome.signingAllowed === false &&
          outcome.executionAllowed === false &&
          outcome.providerQualified === false,
      );
      check(
        outcome.reads[3]?.requestSha256 === files['3.request.json'][1] &&
          outcome.reads[3]?.responseSha256 === files['3.response.bin'][1] &&
          outcome.reads[3]?.httpStatus === 200,
      );
      check(
        outcome.reads[4]?.requestSha256 === files['4.request.json'][1] &&
          outcome.reads[4]?.responseSha256 === files['4.response.bin'][1] &&
          outcome.reads[4]?.httpStatus === 200,
      );
      check(
        Number.isSafeInteger(original.originalFloor) &&
          Number.isSafeInteger(original.accountSlot) &&
          Array.isArray(original.packets) &&
          original.packets.length === 2,
      );
      stage = 'collector';
      const requests = [request3, request4],
        responses = [response3, response4];
      let count = 0;
      const result = await collectJitoCoherentPrefeeAttempt({
        packets: original.packets,
        minimumSlot: original.originalFloor,
        minimumReadSlot: original.accountSlot,
        feeIdPrefix: 'native-fees:1',
        simulationRpcId: 'native-exact:1',
        verifySignatures: false,
        diagnosticTiming: true,
        signal: new AbortController().signal,
        transport: async (request) => {
          check(
            count < 2 &&
              request.phase === (count === 0 ? 'discovery-batch' : 'exact'),
          );
          check(request.methodCount === (count === 0 ? 3 : 1));
          check(Buffer.from(request.body, 'utf8').equals(requests[count]));
          const bytes = responses[count++];
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          check(Buffer.from(text, 'utf8').equals(bytes));
          return new Response(text, { status: 200 });
        },
      });
      stage =
        count === 2
          ? 'two-requests'
          : count === 1
            ? 'one-request'
            : 'no-request';
      check(count === 2 && result.status === 'captured');
      stage = 'admission';
      check(
        result.signingAllowed === false &&
          result.executionAllowed === false &&
          result.automaticExecutionAllowed === false &&
          result.providerQualified === false &&
          result.sourceAuthenticated === false &&
          result.signatureVerified === false &&
          result.altStateVerified === false &&
          result.runtimePrivilegesVerified === false &&
          result.economicOutputVerified === false,
      );
      check(
        result.fees?.status === 'observed' &&
          result.simulation?.status === 'admitted',
      );
      check(
        result.fees?.simulationBankSlot === outcome.bank &&
          result.simulation?.frames.slot === outcome.bank,
      );
      const timing = result.diagnosticTimings;
      check(!!timing);
      const safe = Object.fromEntries(
        Object.entries(timing).map(([key, value]) => [
          key,
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 30000
            ? value
            : null,
        ]),
      );
      // Only these scalar elapsed times leave the private evidence directory.
      console.info(
        'Historical native fixture, in-memory replay only: ' +
          JSON.stringify(safe),
      );
    } catch {
      throw Error(
        `Offline replay refused at ${stage}. No private evidence was printed.`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
