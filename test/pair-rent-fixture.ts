/** Synthetic, protocol-shaped rent; the application never calls this fixture. */
export function pairRentAccount(rate = 10n, threshold = 1, burn = 50) {
  const bytes = new Uint8Array(17),
    view = new DataView(bytes.buffer);
  view.setBigUint64(0, rate, true);
  view.setFloat64(8, threshold, true);
  bytes[16] = burn;
  return {
    owner: 'Sysvar1111111111111111111111111111111111111',
    executable: false,
    lamports: '1009200',
    space: '17',
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
}
