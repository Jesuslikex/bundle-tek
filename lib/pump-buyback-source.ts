import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
import {
  pumpAccountBytes,
  pumpSystemAccount,
  verifyPumpTokenCustody,
  type PumpRpcAccount,
} from './pump-launch-simulation';

type Policy = {
  quoteMint: string;
  quote: { tokenProgram: string };
  buyerAccounts: readonly {
    buybackAccount: string;
    buybackRecipient: string;
  }[];
};

/** Only packet-derived shared fee balances may vary. Keep existence, rent, custody and every other byte. */
export async function pumpBuybackSourceHash(
  packet: Policy,
  address: string,
  observed: PumpRpcAccount,
) {
  const buyer = packet.buyerAccounts.find((b) => b.buybackAccount === address);
  let account = observed;
  if (buyer) {
    if (packet.quoteMint === PUMP_NATIVE_QUOTE) {
      if (!pumpSystemAccount(account))
        throw new Error('Pump shared fee recipient authority differs.');
      account = { ...account!, lamports: '0' };
    } else if (account) {
      const bytes = pumpAccountBytes(account);
      if (bytes.length < 165)
        throw new Error('Pump shared fee custody is truncated.');
      verifyPumpTokenCustody(account, {
        program: packet.quote.tokenProgram,
        mint: packet.quoteMint,
        owner: buyer.buybackRecipient,
        amount: new DataView(bytes.buffer).getBigUint64(64, true),
      });
      bytes.fill(0, 64, 72);
      account = {
        ...account,
        data: [Buffer.from(bytes).toString('base64'), 'base64'],
      };
    }
  }
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(account)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
