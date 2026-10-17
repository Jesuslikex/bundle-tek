import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  address,
  blockhash,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';

/** Synthetic keys and stub parent tables only; never a funded wallet or provider. */
export async function pairExecutionFixture(seedByte = 9) {
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  const wallet = bs58.encode(pair.publicKey);
  const program = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const message = getCompiledTransactionMessageEncoder().encode({
    version: 0,
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 1,
    },
    staticAccounts: [address(wallet), address(program)],
    lifetimeToken: blockhash(bs58.encode(new Uint8Array(32).fill(3))),
    instructions: [
      {
        programAddressIndex: 1,
        accountIndices: [0],
        data: Uint8Array.from([1, 2, 3]),
      },
    ],
    addressTableLookups: [],
  } as Parameters<
    ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']
  >[0]);
  const raw = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  const packet = getBase64Decoder().decode(raw);
  const packetSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const sign = (secret = pair.secretKey) => {
    const tx = getTransactionDecoder().decode(raw);
    const sig = nacl.sign.detached(Uint8Array.from(tx.messageBytes), secret);
    return {
      signature: bs58.encode(sig),
      signedPacket: getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { [address(wallet)]: sig as SignatureBytes },
        }),
      ),
    };
  };
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE pair_order_first_reviews(id TEXT PRIMARY KEY,owner_id TEXT,wallet TEXT,document TEXT,expires_at TEXT);
CREATE TABLE pair_order_first_authorizations(id TEXT PRIMARY KEY,review_id TEXT,owner_id TEXT,document TEXT,created_at TEXT,expires_at TEXT);
CREATE TABLE solana_execution_reservations(owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,wallet_address));
CREATE TABLE pump_launch_reviews(id TEXT,owner_id TEXT,payer TEXT,state TEXT,review TEXT);`);
  sqlite.exec(
    readFileSync('drizzle/0097_pair_order_executions.sql', 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    ),
  );
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async run() {
          return {
            meta: {
              changes: Number(sqlite.prepare(sql).run(...values).changes),
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const outputMint = bs58.encode(new Uint8Array(32).fill(5));
  const inputMint = 'So11111111111111111111111111111111111111112';
  function reserve(
    options: {
      owner?: string;
      authExpiresIn?: number;
      reviewExpiresIn?: number;
      lastValidBlockHeight?: string;
      minimumOutputRaw?: string;
      packetOverride?: string;
      outputMintOverride?: string;
    } = {},
  ) {
    const owner = options.owner ?? 'alice';
    const reviewId = crypto.randomUUID(),
      authorizationId = crypto.randomUUID();
    const now = Date.now();
    const authExpires = new Date(
      now + (options.authExpiresIn ?? 5000),
    ).toISOString();
    const reviewExpires = new Date(
      now + (options.reviewExpiresIn ?? 60000),
    ).toISOString();
    const createdAt = new Date(now).toISOString();
    const lvbh = options.lastValidBlockHeight ?? '1000';
    const minimum = options.minimumOutputRaw ?? '995000';
    sqlite
      .prepare('INSERT INTO pair_order_first_reviews VALUES (?,?,?,?,?)')
      .run(
        reviewId,
        owner,
        wallet,
        JSON.stringify({
          candidate: {
            order: {
              preparation: {
                transaction: packet,
                sha256: packetSha256,
                lastValidBlockHeight: lvbh,
              },
            },
          },
          review: { inputMint, outputMint },
        }),
        reviewExpires,
      );
    sqlite
      .prepare(
        'INSERT INTO pair_order_first_authorizations VALUES (?,?,?,?,?,?)',
      )
      .run(
        authorizationId,
        reviewId,
        owner,
        JSON.stringify({
          packetSha256,
          minimumOutputRaw: minimum,
          scope: 'sign-exact-reviewed-packet-only',
        }),
        createdAt,
        authExpires,
      );
    sqlite
      .prepare(
        "INSERT INTO pair_order_executions (authorization_id,review_id,owner_id,wallet,packet,packet_sha256,input_mint,output_mint,minimum_output_raw,last_valid_block_height,authorization_expires_at,review_expires_at,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)",
      )
      .run(
        authorizationId,
        reviewId,
        owner,
        wallet,
        options.packetOverride ?? packet,
        packetSha256,
        inputMint,
        options.outputMintOverride ?? outputMint,
        minimum,
        lvbh,
        authExpires,
        reviewExpires,
        createdAt,
        createdAt,
      );
    return { authorizationId, reviewId, owner };
  }
  return {
    sqlite,
    db,
    wallet,
    pair,
    packet,
    packetSha256,
    sign,
    reserve,
    inputMint,
    outputMint,
    program,
    close: () => sqlite.close(),
  };
}
