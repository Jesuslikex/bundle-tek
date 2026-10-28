import { expect, it, vi } from 'vitest';
import { readJitoRecoveryLocator } from './jito-recovery-locator';

const encoder = new TextEncoder();
const fixture = () => ({
  format: 'jito-signed-packet-recovery-v1',
  projectId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
  bundleId: '33333333-3333-3333-3333-333333333333',
  sha256: 'a'.repeat(64),
  packet: 2,
  signature: 'private-signature-value',
  transaction: 'private-signed-packet-value',
});
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
const error = 'Recovery file is unavailable or invalid.';

it('returns only frozen non-secret lookup hints and no authority', async () => {
  const f = fixture();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(Error('network'));
  try {
    const locator = await readJitoRecoveryLocator(bytes(f));
    expect(locator).toEqual({
      projectId: f.projectId,
      sessionId: f.sessionId,
      bundleId: f.bundleId,
      sha256: f.sha256,
      packet: f.packet,
    });
    expect(Object.isFrozen(locator)).toBe(true);
    expect(JSON.stringify(locator)).not.toContain('private');
    expect(Reflect.ownKeys(locator)).toHaveLength(5);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});

it.each([
  ['format', 'different'],
  ['projectId', 'invalid'],
  ['sessionId', 'invalid'],
  ['bundleId', 'invalid'],
  ['bundleId', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
  ['sha256', 'A'.repeat(64)],
  ['sha256', 'a'.repeat(63)],
  ['packet', -1],
  ['packet', 5],
  ['packet', 0.5],
  ['packet', '2'],
  ['signature', null],
  ['signature', ''],
  ['transaction', null],
  ['transaction', ''],
] as const)('rejects invalid %s metadata or fields', async (name, value) => {
  await expect(
    readJitoRecoveryLocator(bytes({ ...fixture(), [name]: value })),
  ).rejects.toThrow(error);
});

it('accepts the packet bounds without claiming that a signature is valid', async () => {
  for (const packet of [0, 4])
    expect(
      (await readJitoRecoveryLocator(bytes({ ...fixture(), packet }))).packet,
    ).toBe(packet);
});

it('rejects missing, extra, array and non-object schemas', async () => {
  const { signature: _signature, ...missing } = fixture();
  for (const value of [missing, { ...fixture(), extra: true }, [], null, 2])
    await expect(readJitoRecoveryLocator(bytes(value))).rejects.toThrow(error);
});

it.each([
  '{"bundleId":"a","bundleId":"b"}',
  '{"bundleId":"a","bu\\u006edleId":"b"}',
  '{"signature":"a","sign\\u0061ture":"b"}',
  '{"format":"\\ud800"}',
  '{"packet":-0}',
  '{"packet":2e0}',
  '{"nested":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}',
])(
  'rejects duplicate, malformed or deeply nested JSON safely',
  async (text) => {
    await expect(readJitoRecoveryLocator(encoder.encode(text))).rejects.toThrow(
      error,
    );
  },
);

it('rejects invalid UTF-8 and input above the exact byte limit', async () => {
  await expect(readJitoRecoveryLocator(Uint8Array.of(0xff))).rejects.toThrow(
    error,
  );
  const text = JSON.stringify(fixture());
  const exact = encoder.encode(text + ' '.repeat(4096 - text.length));
  expect((await readJitoRecoveryLocator(exact)).bundleId).toBe(
    fixture().bundleId,
  );
  await expect(readJitoRecoveryLocator(new Uint8Array(4097))).rejects.toThrow(
    error,
  );
  await expect(readJitoRecoveryLocator(new Uint8Array())).rejects.toThrow(
    error,
  );
});

it('reads only the declared byte view and rejects prototype-named extra fields', async () => {
  const original = bytes(fixture());
  const backing = new Uint8Array(original.length + 20);
  backing.fill(0xff);
  backing.set(original, 10);
  const view = backing.subarray(10, 10 + original.length);
  expect((await readJitoRecoveryLocator(view)).bundleId).toBe(
    fixture().bundleId,
  );
  const text = JSON.stringify(fixture()).replace(
    /}$/,
    ',"__proto__":{"polluted":true}}',
  );
  await expect(readJitoRecoveryLocator(encoder.encode(text))).rejects.toThrow(
    error,
  );
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});

it('snapshots input before awaiting and does not invoke an own byteLength getter', async () => {
  const original = bytes(fixture());
  const getter = vi.fn(() => 1);
  Object.defineProperty(original, 'byteLength', { get: getter });
  const pending = readJitoRecoveryLocator(original);
  original.fill(0);
  expect((await pending).bundleId).toBe(fixture().bundleId);
  expect(getter).not.toHaveBeenCalled();
});

it('rejects proxy and non-byte views without invoking their traps', async () => {
  const input = bytes(fixture());
  const getPrototypeOf = vi.fn(() => Uint8Array.prototype);
  const get = vi.fn(() => {
    throw Error('Unexpected proxy getter');
  });
  const proxied = new Proxy(input, { getPrototypeOf, get });
  await expect(readJitoRecoveryLocator(proxied)).rejects.toThrow(error);
  expect(getPrototypeOf).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  for (const other of [new Uint16Array(16), new DataView(new ArrayBuffer(16))])
    await expect(
      readJitoRecoveryLocator(other as unknown as Uint8Array),
    ).rejects.toThrow(error);
});

it('rejects shared memory safely', async () => {
  const input = bytes(fixture());
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new Uint8Array(new SharedArrayBuffer(input.length));
    shared.set(input);
    await expect(readJitoRecoveryLocator(shared)).rejects.toThrow(error);
  }
});
