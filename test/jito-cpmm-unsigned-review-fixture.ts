import bs58 from 'bs58';
import type { JitoCpmmReviewFacts } from '../lib/jito-cpmm-unsigned-review';
export const unsignedReviewContext = {
  ownerScope: 'ab'.repeat(32),
  projectId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
};
export function unsignedReviewFacts(): JitoCpmmReviewFacts {
  return {
    capturedAt: '2026-10-31T12:00:00.000Z',
    payer: bs58.encode(new Uint8Array(32).fill(1)),
    pool: bs58.encode(new Uint8Array(32).fill(2)),
    inputMint: bs58.encode(new Uint8Array(32).fill(3)),
    outputMint: bs58.encode(new Uint8Array(32).fill(4)),
    inputRaw: '1000000',
    expectedOutputRaw: '190000',
    minimumOutputRaw: '190000',
    tipLamports: '1000',
    networkFeeLamports: '20000',
    maximumFeeLamports: '80000',
    createdRentLamports: '2039280',
    retainedRentLamports: '890880',
    minimumSlot: '100',
    simulationSlot: '115',
    maximumSlot: '129',
    blockhash: bs58.encode(new Uint8Array(32).fill(5)),
    lastValidBlockHeight: '123456',
    priceDifferenceBps: '-14',
    packetSha256s: ['11', '22', '33', '44'].map((s) => s.repeat(32)),
  };
}
