export type HoldingsBatchCode =
  | 'BATCH_TOO_LARGE'
  | 'RESULT_TOO_LARGE'
  | 'BATCH_RPC_ERROR'
  | 'INVALID_BATCH';
export class HoldingsBatchError extends Error {
  constructor(readonly code: HoldingsBatchCode) {
    super('Holdings batch response rejected.');
    this.name = 'HoldingsBatchError';
  }
}
