import { WARMUP_EXECUTION_GENESIS_SCHEMA_SHA256 } from './wallet-warmup-execution-genesis-schema';

// Exact control-only storage and original genesis/lease/root dependencies.
export const WARMUP_EXECUTION_CONTROL_SCHEMA_SHA256: Readonly<
  Record<string, string>
> = {
  ...WARMUP_EXECUTION_GENESIS_SCHEMA_SHA256,
  wallet_warmup_execution_control_events:
    'b256bc3111d1743018278851203491b84821ab0ec2c468e10e867c0a901b3ac3',
  wallet_warmup_execution_control_heads:
    '361bea5a7fe3a6dee56dad90533bae2b128938f50fe1333b68d9686c826c1880',
  wallet_warmup_execution_control_intents:
    '6b6fb30d2b8c52b476371c9eb864ad46539540aca36b050a3930b28e55fc2d34',
  warmup_execution_control_event_advance:
    'd01a95e032ade1b11d8f61b4c499959c3de6e3df00cdf4a3d443a967311a3d34',
  warmup_execution_control_event_insert:
    '8ec13f43d4c9ff11de096ea7df5c6922ec1e00264e2f45f3e1d5d6a384cc94d4',
  warmup_execution_control_event_no_delete:
    'ec9e05f828d5fad8ad7b7ef073dd9afe83412030a98d69e775f359d3bb013685',
  warmup_execution_control_event_no_update:
    '0b39d99eab5090adc7cbaf21840de08dbb4ffc009d6756d2dad5f2a77e05c673',
  warmup_execution_control_event_wire:
    '9e14b0a1dd6ef12e774f1a9329caa89da4c23160c3cd4efe745a5832c51fa1f2',
  warmup_execution_control_head_advance:
    'c2d6a99f1d5cc4ea5aba24a56f2f5bc1b9fe2bf49109fd236651bd71fb6f3553',
  warmup_execution_control_head_no_delete:
    'e081a2b2037567c93f3fb468e148e2eb588668665fe491bdd451796b216534bf',
  warmup_execution_control_head_seed:
    'edc76cc049dacf12dc2fe98e21515a9d3535b0b7854164d543fc97fd1b4b38db',
  warmup_execution_control_intent_capacity:
    'c91bee55d60f0b1ea08ef261daae9296b67ad00bbffcf86b579362986472e276',
  warmup_execution_control_intent_insert:
    '27ed77bc1ead31003b607f22c4a8292bc474ccb25349615204bb31fc51e3545f',
  warmup_execution_control_intent_no_delete:
    '70d375bf99081f00fbc6b17d0f84239a4f383bd01de98295070307865c4f2010',
  warmup_execution_control_intent_no_update:
    'fbd873187544918c44682418852f25255a1a39d60961113fbc699686927b63d9',
  warmup_execution_control_intents_root:
    'fd7015c8be8ab3991a1c3dc34c9a0441b11cef16ac9b8aca00c57648b4f02287',
};
