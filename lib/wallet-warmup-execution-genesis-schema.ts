import { WARMUP_EXECUTION_LEASE_SCHEMA_SHA256 } from './wallet-warmup-execution-lease-schema';

// Exact immutable genesis storage and original lease/root/review dependencies.
export const WARMUP_EXECUTION_GENESIS_SCHEMA_SHA256: Readonly<
  Record<string, string>
> = {
  ...WARMUP_EXECUTION_LEASE_SCHEMA_SHA256,
  wallet_warmup_execution_geneses:
    '6456b93e8e5dfe55d3fb9b8774648ce1e5fe80f5901b9525179ddd390be8bfda',
  warmup_execution_genesis_insert:
    '8db01782f25251035445ac7e042a9ba245ac7c485b5a33f87a8aab368c3a7457',
  warmup_execution_genesis_no_delete:
    '60b246c13d9345a5ae442fd28b133c4ae899b62c720e915d8e289b9a0a6f6081',
  warmup_execution_genesis_no_update:
    '742846365a0846831d50f7603432ef88497549aaf9f7121cb963855eb54aac8b',
};
