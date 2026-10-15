import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit-v1';
/** Generated test keys only. No RPC, wallet vault access or broadcast. */
export function signSyntheticPumpGroup(
  packets: { transaction: string }[],
  keys: { address: string; keyPair: CryptoKeyPair }[],
) {
  return Promise.all(
    packets.map(async (packet) => {
      const tx = getTransactionDecoder().decode(
          Buffer.from(packet.transaction, 'base64'),
        ),
        signatures = { ...tx.signatures };
      for (const publicKey of Object.keys(signatures)) {
        const key = keys.find((value) => value.address === publicKey);
        if (!key) throw new Error('Synthetic group signer missing.');
        signatures[address(publicKey)] = new Uint8Array(
          await crypto.subtle.sign(
            'Ed25519',
            key.keyPair.privateKey,
            Uint8Array.from(tx.messageBytes),
          ),
        ) as SignatureBytes;
      }
      return getBase64Decoder().decode(
        getTransactionEncoder().encode({ ...tx, signatures }),
      );
    }),
  );
}
