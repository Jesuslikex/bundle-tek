import { it, expect } from 'vitest';
import bs58 from 'bs58';
import { isImportedSigningEvent } from './imported-signing-events';
const row = () => ({
  id: 'a'.repeat(32),
  sequence: 1,
  intentId: crypto.randomUUID(),
  preparationId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  projectRevision: 2,
  walletRevision: 3,
  wallet: bs58.encode(new Uint8Array(32).fill(1)),
  type: 'approval.reviewed',
  state: 'awaiting_signature',
  signature: null,
  document: {
    side: 'Buy',
    sha256: 'b'.repeat(64),
    inputMint: bs58.encode(new Uint8Array(32).fill(2)),
    outputMint: bs58.encode(new Uint8Array(32).fill(3)),
    inputRaw: '2000000',
    minimumOutputRaw: '1000',
  },
  createdAt: new Date().toISOString(),
});
it('requires exact approval state and real signature shape, including retained baselines', () => {
  const event = row();
  expect(isImportedSigningEvent(event)).toBe(true);
  const signed = {
    ...event,
    type: 'approval.signed',
    state: 'signed',
    signature: bs58.encode(new Uint8Array(64).fill(4)),
  };
  expect(isImportedSigningEvent(signed)).toBe(true);
  expect(isImportedSigningEvent({ ...signed, signature: null })).toBe(false);
  expect(isImportedSigningEvent({ ...signed, state: 'submitted' })).toBe(false);
  expect(isImportedSigningEvent({ ...signed, type: 'approval.baseline' })).toBe(
    true,
  );
  expect(
    isImportedSigningEvent({ ...event, signature: signed.signature }),
  ).toBe(false);
  expect(isImportedSigningEvent({ ...event, type: 'toString' })).toBe(false);
  expect(isImportedSigningEvent({ ...signed, signature: event.wallet })).toBe(
    false,
  );
});
it('rejects ambiguous amounts and malformed retained identity or packet context', () => {
  const event = row();
  for (const raw of [
    '0',
    '01',
    '-1',
    '1.0',
    '18446744073709551616',
    '1'.repeat(100),
  ])
    expect(
      isImportedSigningEvent({
        ...event,
        document: { ...event.document, inputRaw: raw },
      }),
    ).toBe(false);
  expect(
    isImportedSigningEvent({
      ...event,
      document: { ...event.document, inputRaw: '18446744073709551615' },
    }),
  ).toBe(true);
  for (const patch of [
    { projectRevision: 0 },
    { walletRevision: 1.5 },
    { sequence: 0 },
    { projectId: 'not-a-project' },
    { wallet: 'not-a-wallet' },
    { createdAt: 'invalid' },
  ])
    expect(isImportedSigningEvent({ ...event, ...patch })).toBe(false);
  expect(
    isImportedSigningEvent({
      ...event,
      document: { ...event.document, sha256: 'bad' },
    }),
  ).toBe(false);
  expect(isImportedSigningEvent(null)).toBe(false);
  expect(isImportedSigningEvent({})).toBe(false);
});
