// Synthetic full-protocol fixture adapted from the existing broadcast service
// regression setup. Never invokes submit; generated keys and receipts only.
import { vi, type MockedFunction } from 'vitest';
import type { Client } from '@libsql/client';
import bs58 from 'bs58';
import { pumpGroupBroadcastFixture } from './pump-group-broadcast-fixture';
import type { preflightOwnedPumpCreate } from '../lib/owned-pump-preflight';
import { authorizeOwnedPumpGroupSigning } from '../lib/pump-group-runtime-service';
import {
  prepareOwnedPumpGroupBroadcast,
  registerOwnedPumpGroupTip,
  type PumpGroupJitoRpc,
} from '../lib/pump-group-broadcast-service';
import {
  buildPumpGroupTip,
  PUMP_GROUP_JITO_TIP_ACCOUNTS,
  type PumpGroupBroadcastConsent,
} from '../lib/pump-group-broadcast';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';
const signal = () => new AbortController().signal;
export async function pumpPurchaseSettlementFixture(
  mocked: MockedFunction<typeof preflightOwnedPumpCreate>,
  clients: Client[],
) {
  const clock = new Date('2026-10-15T12:00:00.000Z');
  // CPU/SQL setup time must not age synthetic authorization evidence. Native
  // AbortSignal deadlines and all other timers remain real and enforced.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  const f = await pumpGroupBroadcastFixture(mocked, clients, clock);
  const preview = await f.preview();
  await authorizeOwnedPumpGroupSigning(
    f.db,
    'alice',
    f.saved.review.id,
    preview.id,
    f.consent,
    {
      approved: true,
      previewId: preview.id,
      identitySha256: preview.identitySha256,
      acknowledgeUpgradeableCode: true,
      acknowledgeNoSemanticAudit: true,
    },
    signal(),
    f.provider,
  );
  const group = await f.register();
  const tipRecipient = PUMP_GROUP_JITO_TIP_ACCOUNTS[0];
  const control = {
    badTip: false,
    tipErr: null as unknown,
    groupErr: null as unknown,
    chain: false,
    tipOnly: false,
    expiry: false,
    unknown: false,
    tipMissing: false,
    landed: null as number[] | null,
    packetErrs: null as unknown[] | null,
  };
  let tipBytes = '',
    tipSignature = '';
  const sends: unknown[][] = [],
    reads: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, sig) => {
    reads.push({ method, params });
    if (method === 'getTransaction') {
      if (!control.chain) return null;
      if (params[0] === tipSignature && control.tipMissing) return null;
      if (params[0] === tipSignature)
        return {
          slot: '250',
          transaction: [tipBytes, 'base64'],
          meta: {
            err: control.tipErr,
            fee: '5000',
            preBalances: ['100000000', '1000000', '1'],
            postBalances:
              control.tipErr === null
                ? ['99994000', '1001000', '1']
                : ['99995000', '1000000', '1'],
          },
        };
      if (control.tipOnly) return null;
      const packet = group.signedEvidence!.packets.find(
        (p) => p.signature === params[0],
      );
      if (!packet) throw new Error('Unexpected receipt signature');
      const index = group.signedEvidence!.packets.indexOf(packet);
      if (control.landed && !control.landed.includes(index)) return null;
      return {
        slot: '250',
        transaction: [packet.transaction, 'base64'],
        meta: {
          err: control.packetErrs
            ? control.packetErrs[index]
            : control.groupErr,
          fee: '5000',
        },
      };
    }
    if (method === 'getEpochInfo')
      return {
        absoluteSlot: (f.last + 2000n).toString(),
        blockHeight: (control.expiry ? f.last + 33n : f.last - 20n).toString(),
      };
    if (method === 'getAccountInfo' && control.expiry)
      return { context: { slot: (f.last + 2001n).toString() }, value: null };
    if (
      method === 'getFeeForMessage' &&
      Buffer.from(String(params[0]), 'base64')[0] === 1
    )
      return { context: { slot: '100' }, value: '5000' };
    const value = await f.provider(method, params, sig);
    if (method !== 'simulateBundle') return value;
    const req = params[0] as { encodedTransactions: string[] },
      cfg = params[1] as {
        postExecutionAccountsConfigs: { addresses: string[] }[];
      };
    if (req.encodedTransactions.length !== group.review.packets.length + 1)
      return value;
    const result = structuredClone(value) as {
      value: { transactionResults: Record<string, unknown>[] };
    };
    const last = result.value.transactionResults.at(-1)!;
    const payerIndex = cfg.postExecutionAccountsConfigs[
      group.review.packets.length - 1
    ].addresses.indexOf(group.review.input.create.payer);
    const payer = structuredClone(
      (last.postExecutionAccounts as Record<string, unknown>[])[payerIndex],
    );
    const receiver = {
      owner: '11111111111111111111111111111111',
      executable: false,
      lamports: '1000000',
      data: ['', 'base64'],
    };
    result.value.transactionResults.push({
      err: null,
      replacementBlockhash: null,
      preExecutionAccounts: [payer, receiver],
      postExecutionAccounts: [
        {
          ...payer,
          lamports: (BigInt(String(payer.lamports)) - 6000n).toString(),
        },
        { ...receiver, lamports: control.badTip ? '1001001' : '1001000' },
      ],
      fee: '5000',
      unitsConsumed: '150',
      loadedAccountsDataSize: '0',
    });
    return result;
  };
  const jito: PumpGroupJitoRpc = async (method, params) => {
    if (method === 'getTipAccounts') return [tipRecipient];
    if (method === 'getBundleStatuses') return { value: [null] };
    sends.push(params);
    if (control.unknown) throw new Error('Lost response');
    return 'a'.repeat(64);
  };
  const prepare = () =>
    prepareOwnedPumpGroupBroadcast(
      f.db,
      'alice',
      group.review.id,
      '1000',
      '5000',
      signal(),
      rpc,
      jito,
    );
  async function ready() {
    const prepared = (await prepare())!;
    const { message } = buildPumpGroupTip(prepared.review);
    const signed = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        f.f.f.payerSigner.keyPair.privateKey,
        message,
      ),
    );
    tipBytes = Buffer.from(
      Uint8Array.from([1, ...signed, ...message]),
    ).toString('base64');
    tipSignature = bs58.encode(signed);
    const saved = await registerOwnedPumpGroupTip(
      f.db,
      'alice',
      group.review.id,
      prepared.review.id,
      prepared.review.sha256,
      tipBytes,
      signal(),
    );
    const consent: PumpGroupBroadcastConsent = {
      approved: true,
      reviewId: group.review.id,
      broadcastId: prepared.review.id,
      broadcastSha256: prepared.review.sha256,
      signedGroupSha256: prepared.review.signedGroupSha256,
      scope: 'one-attempt-jito-complete-group-and-tip',
      acknowledgeUncertainOutcome: true,
    };
    return { saved, consent };
  }
  return { ...f, group, rpc, jito, sends, reads, control, prepare, ready };
}
