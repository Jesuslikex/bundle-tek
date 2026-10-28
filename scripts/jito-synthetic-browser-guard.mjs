/** Enforce a unique loopback hostname and reject alternate Host headers. */
import { randomBytes } from 'node:crypto';
export const newSyntheticHost = () =>
  `jito-${randomBytes(16).toString('hex')}.localhost`;
export function acceptsSyntheticHost(host, port, remote, expected) {
  return (
    /^jito-[a-f0-9]{32}\.localhost$/.test(expected) &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535 &&
    host === `${expected}:${port}` &&
    (remote === '127.0.0.1' || remote === '::ffff:127.0.0.1')
  );
}
