import { expect, it } from 'vitest';
import { routeMessage } from '../test/jupiter-route-fixture';
import { reviewSwapInstructions } from './swap-instruction-review';
import {
  reviewPairRuntimeTrace,
  pairRuntimeDigest,
} from './pair-runtime-trace';
const message = routeMessage({ v2: true }),
  top = reviewSwapInstructions(message),
  keys = message.staticAccounts.map(String),
  writable = keys.slice(0, 3);
const compiled = () => ({
  programIdIndex: '5',
  accounts: ['1', '2', '0'],
  data: '3Bxs4h',
  stackHeight: '2',
});
const run = (raw: unknown) => reviewPairRuntimeTrace(raw, top, keys, writable);
it.each(['compiled', 'partial', 'parsed'] as const)(
  'preserves %s CPI evidence without pretending parser labels verify bytes',
  async (kind) => {
    const ix =
      kind === 'compiled'
        ? compiled()
        : kind === 'partial'
          ? {
              programId: keys[5],
              accounts: [keys[1], keys[2], keys[0]],
              data: '3Bxs4h',
              stackHeight: 2,
            }
          : {
              programId: keys[5],
              program: 'spl-token',
              parsed: {
                type: 'transfer',
                info: {
                  source: keys[1],
                  destination: keys[2],
                  amount: '9007199254740993',
                },
              },
              stackHeight: 2,
            };
    const trace = await run([{ index: 0, instructions: [ix] }]);
    expect(trace.programs).toEqual([keys[6], keys[5]].sort());
    expect(trace.calls[0]).toMatchObject({
      program: keys[5],
      parentProgram: keys[6],
      stackHeight: 2,
    });
    expect(trace.rawInstructionCoverageComplete).toBe(kind !== 'parsed');
    expect(trace.innerInstructionPolicyVerified).toBe(false);
    expect(trace.signingAllowed).toBe(false);
  },
);
it('tracks nested parent calls and returns from deeper frames', async () => {
  const nested = { ...compiled(), programIdIndex: '6', stackHeight: '3' };
  const trace = await run([
    { index: '0', instructions: [compiled(), nested, compiled()] },
  ]);
  expect(trace.calls.map((c) => c.parentProgram)).toEqual([
    keys[6],
    keys[5],
    keys[6],
  ]);
});
it.each([
  'missing',
  'empty',
  'duplicate-group',
  'foreign-program',
  'foreign-account',
  'writable-program',
  'bad-index',
  'bad-data',
  'missing-height',
  'jump-depth',
  'too-deep',
  'unknown-shape',
  'missing-parsed-info',
] as const)('rejects %s trace evidence', async (mode) => {
  const ix: Record<string, unknown> = compiled();
  let raw: unknown = [{ index: 0, instructions: [ix] }];
  if (mode === 'missing') raw = null;
  if (mode === 'empty') raw = [];
  if (mode === 'duplicate-group')
    raw = [
      { index: 0, instructions: [ix] },
      { index: 0, instructions: [ix] },
    ];
  if (mode === 'foreign-program') ix.programIdIndex = '250';
  if (mode === 'foreign-account') ix.accounts = ['250'];
  if (mode === 'writable-program') ix.programIdIndex = '0';
  if (mode === 'bad-index') ix.programIdIndex = '05';
  if (mode === 'bad-data') ix.data = '0!';
  if (mode === 'missing-height') delete ix.stackHeight;
  if (mode === 'jump-depth') ix.stackHeight = '3';
  if (mode === 'too-deep') ix.stackHeight = '65';
  if (mode === 'unknown-shape') ix.signed = true;
  if (mode === 'missing-parsed-info')
    raw = [
      {
        index: 0,
        instructions: [
          {
            programId: keys[5],
            program: 'spl-token',
            parsed: { type: 'transfer' },
            stackHeight: 2,
          },
        ],
      },
    ];
  await expect(run(raw)).rejects.toThrow();
});
it('binds parsed information canonically while retaining precision and distinguishing changes', async () => {
  expect(await pairRuntimeDigest({ b: '9007199254740993', a: 1 })).toBe(
    await pairRuntimeDigest({ a: 1, b: '9007199254740993' }),
  );
  expect(await pairRuntimeDigest({ amount: '9007199254740993' })).not.toBe(
    await pairRuntimeDigest({ amount: '9007199254740992' }),
  );
});
