import { describe, expect, it } from 'vitest';
import type { JitoBundleRecord } from './jito-bundle';
import {
  createJitoChainObservation,
  requireJitoChainObservation,
} from './jito-chain-observation';

const record = {
  manifest: { id: 'bundle-id', sha256: 'ab'.repeat(32) },
  state: 'submitted',
  signatures: ['signature-one', null, 'signature-three'],
  updatedAt: '2026-10-28T12:00:00.000Z',
} as unknown as JitoBundleRecord;
const at = '2026-10-28T12:01:00.000Z';

describe('read-only Jito packet observations', () => {
  it('maps compact provider results back to their original packet indices without exposing raw errors', () => {
    const value = createJitoChainObservation(
      record,
      {
        value: [
          {
            slot: '123',
            confirmationStatus: 'finalized',
            err: { InstructionError: ['private-provider-detail'] },
          },
          null,
        ],
      },
      at,
    );
    expect(value?.packets).toEqual([
      {
        packet: 0,
        signature: 'signature-one',
        status: 'finalized-failure',
        slot: 123,
      },
      { packet: 1, signature: null, status: 'not-registered', slot: null },
      {
        packet: 2,
        signature: 'signature-three',
        status: 'not-found',
        slot: null,
      },
    ]);
    expect(JSON.stringify(value)).not.toContain('private-provider-detail');
    expect(requireJitoChainObservation(value, record)).toEqual(value);
  });

  it.each(['processed', 'confirmed', 'finalized'] as const)(
    'labels provider %s status without treating it as a receipt',
    (commitment) => {
      for (const error of [null, 'private-error']) {
        const result = createJitoChainObservation(
          record,
          {
            value: [
              { slot: '456', confirmationStatus: commitment, err: error },
              { slot: 457, confirmationStatus: commitment, err: null },
            ],
          },
          at,
        );
        expect(result?.packets[0].status).toBe(
          `${commitment}-${error === null ? 'success' : 'failure'}`,
        );
        expect(JSON.stringify(result)).not.toContain('private-error');
      }
    },
  );

  it.each([
    { slot: '1', confirmationStatus: 'future', err: null },
    { slot: '9007199254740992', confirmationStatus: 'finalized', err: null },
    { slot: '0', confirmationStatus: 'finalized', err: null },
    { slot: '12', confirmationStatus: 'finalized' },
    { slot: '12', confirmationStatus: 'finalized', err: 0 },
    [],
    'unexpected',
  ])('treats malformed provider data as unavailable: %j', (status) => {
    const result = createJitoChainObservation(
      record,
      { value: [status, null] },
      at,
    );
    expect(result?.packets[0]).toMatchObject({
      status: 'unavailable',
      slot: null,
    });
  });

  it('omits a report for missing, mismatched or terminal status vectors', () => {
    expect(
      createJitoChainObservation(record, { value: [null] }, at),
    ).toBeNull();
    expect(createJitoChainObservation(record, { value: null }, at)).toBeNull();
    expect(
      createJitoChainObservation(
        { ...record, state: 'expired' },
        { value: [null, null] },
        at,
      ),
    ).toBeNull();
    expect(
      createJitoChainObservation(
        { ...record, signatures: [null, null] },
        { value: [] },
        at,
      ),
    ).toBeNull();
  });

  it('refuses a report rebound to a changed bundle, state, signature, slot or shape', () => {
    const report = createJitoChainObservation(
      record,
      { value: [null, null] },
      at,
    )!;
    for (const other of [
      { ...record, state: 'submitting' },
      { ...record, manifest: { ...record.manifest, sha256: 'cd'.repeat(32) } },
      { ...record, signatures: ['different', null, 'signature-three'] },
    ] as JitoBundleRecord[])
      expect(() => requireJitoChainObservation(report, other)).toThrow(
        'differs',
      );
    for (const bad of [
      { ...report, packets: report.packets.slice(1) },
      {
        ...report,
        packets: report.packets.map((p, i) => (i ? p : { ...p, slot: 100 })),
      },
      {
        ...report,
        packets: report.packets.map((p, i) =>
          i ? p : { ...p, status: 'finalized-success' },
        ),
      },
      { ...report, extra: 'private' },
    ])
      expect(() => requireJitoChainObservation(bad, record)).toThrow('differs');
  });
});
