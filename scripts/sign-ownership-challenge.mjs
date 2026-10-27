import bs58 from 'bs58';
import nacl from 'tweetnacl';

const [key, message] = process.argv.slice(2);
const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(key));
const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
console.log(bs58.encode(sig));
