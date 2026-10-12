import {
  address,
  blockhash as parseBlockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
  pipe,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { SolanaFundingError } from './solana-funding-error';
import { getTransferCheckedWithFeeInstruction } from '@solana-program/token-2022';
import { TOKEN_2022 } from './token-withdrawal-fee';
export async function solanaTokenTransferMessage(input: {
  funder: string;
  recipient: string;
  mint: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  raw: bigint;
  decimals: number;
  createAccount: boolean;
  tokenProgram?: string;
  transferFee?: bigint;
}) {
  const tokenProgram = address(input.tokenProgram ?? TOKEN_PROGRAM_ADDRESS);
  if (
    ![TOKEN_PROGRAM_ADDRESS, TOKEN_2022].includes(tokenProgram) ||
    (input.transferFee !== undefined && tokenProgram !== TOKEN_2022)
  )
    throw new SolanaFundingError('Unsupported token transfer program.');
  const payer = createNoopSigner(address(input.funder));
  const mint = address(input.mint),
    owner = address(input.recipient);
  const [source] = await findAssociatedTokenPda({
    owner: payer.address,
    mint,
    tokenProgram,
  });
  const [destination] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram,
  });
  const instructions = [
    ...(input.createAccount
      ? [
          getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata: destination,
            owner,
            mint,
            tokenProgram,
          }),
        ]
      : []),
    input.transferFee === undefined
      ? getTransferCheckedInstruction(
          {
            source,
            mint,
            destination,
            authority: payer,
            amount: input.raw,
            decimals: input.decimals,
          },
          { programAddress: tokenProgram },
        )
      : getTransferCheckedWithFeeInstruction({
          source,
          mint,
          destination,
          authority: payer,
          amount: input.raw,
          decimals: input.decimals,
          fee: input.transferFee,
        }),
  ];
  const compiled = compileTransactionMessage(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: parseBlockhash(input.blockhash),
            lastValidBlockHeight: input.lastValidBlockHeight,
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  if (compiled.header.numSignerAccounts !== 1)
    throw new SolanaFundingError('Unexpected token transfer signer count.');
  const message = Uint8Array.from(
    getCompiledTransactionMessageEncoder().encode(compiled),
  );
  return { source, destination, message };
}
