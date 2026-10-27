import { describe, expect, it } from 'vitest';
import {
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import { appendSettlementTransfer, SYSTEM_PROGRAM } from './wallet-cleanup';

const payer = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const destination = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const token = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const table = '3oy9ojnsDzqmMNi87Gs7Hn5v3MPVqnWjG9k8BmzKR7yW';

function packet() {
  const message = {
    version: 0 as const,
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 1,
    },
    staticAccounts: [payer, token] as never[],
    instructions: [
      { programAddressIndex: 1, accountIndices: [0], data: new Uint8Array() },
    ],
    addressTableLookups: [
      {
        lookupTableAddress: table,
        writableIndexes: [7],
        readonlyIndexes: [3, 9],
      },
    ],
  };
  const bytes = getCompiledTransactionMessageEncoder().encode(message as never);
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({
      messageBytes: bytes as never,
      signatures: { [payer]: new Uint8Array(64) } as never,
    }),
  );
}

describe('appendSettlementTransfer', () => {
  it('appends an exact system transfer and keeps the message valid', () => {
    const loaded = {
      writable: ['GyY4VgEpJQhiKZRAJJmoM4hv5Q2xC4pvX68MGrGidxyG'],
      readonly: [SYSTEM_PROGRAM, 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf', 'So11111111111111111111111111111111111111112'],
    };
    const out = appendSettlementTransfer(packet(), destination, 6_229_727n, loaded);
    const back = getTransactionDecoder().decode(getBase64Encoder().encode(out));
    const message = getCompiledTransactionMessageDecoder().decode(
      back.messageBytes,
    ) as never as {
      staticAccounts: string[];
      instructions: { programAddressIndex: number; accountIndices: number[]; data: Uint8Array }[];
      addressTableLookups: { writableIndexes: number[]; readonlyIndexes: number[] }[];
      header: { numReadonlyNonSignerAccounts: number };
    };
    const transfer = message.instructions.at(-1)!;
    // The destination and the program are hoisted into the static list so the
    // transfer never depends on a lookup position.
    expect(message.staticAccounts[transfer.accountIndices[1]]).toBe(destination);
    expect(message.staticAccounts[transfer.programAddressIndex]).toBe(SYSTEM_PROGRAM);
    expect(message.addressTableLookups[0].readonlyIndexes).toEqual([9]);
    expect(Array.from(transfer.data)).toEqual([2, 0, 0, 0, 0xdf, 0x0e, 0x5f, 0, 0, 0, 0, 0]);
    expect(message.header.numReadonlyNonSignerAccounts).toBe(2);
  });

  it('reuses a static destination and program without duplicating them', () => {
    const out = appendSettlementTransfer(packet(), token, 1n);
    const back = getTransactionDecoder().decode(getBase64Encoder().encode(out));
    const message = getCompiledTransactionMessageDecoder().decode(
      back.messageBytes,
    ) as never as { staticAccounts: string[] };
    expect(message.staticAccounts.filter((a) => a === token)).toHaveLength(1);
  });
});
