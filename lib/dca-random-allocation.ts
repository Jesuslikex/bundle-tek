const maximum = (1n << 64n) - 1n;
const space = 1n << 64n;
export type DcaRandomization = {
  format: 'bounded-dca-allocation-v1';
  minimumRaw: string;
  maximumRaw: string;
  totalRaw: string;
};
function amount(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > maximum
  )
    throw new Error('Use positive exact Solana input amounts.');
  return BigInt(value);
}
export function dcaRandomization(value: unknown): DcaRandomization {
  const v = value as DcaRandomization;
  if (
    !v ||
    Object.keys(v).sort().join(',') !==
      'format,maximumRaw,minimumRaw,totalRaw' ||
    v.format !== 'bounded-dca-allocation-v1'
  )
    throw new Error('Choose supported randomized DCA bounds.');
  if (amount(v.maximumRaw) < amount(v.minimumRaw))
    throw new Error('Maximum DCA input must be at least its minimum.');
  return {
    format: 'bounded-dca-allocation-v1',
    minimumRaw: v.minimumRaw,
    maximumRaw: v.maximumRaw,
    totalRaw: amount(v.totalRaw).toString(),
  };
}
function feasible(totalRaw: string, cycles: number, bounds: DcaRandomization) {
  const total = amount(totalRaw),
    range = dcaRandomization(bounds);
  if (range.totalRaw !== totalRaw)
    throw new Error(
      'Randomized DCA cycles must conserve the exact total budget.',
    );
  const minimum = amount(range.minimumRaw),
    maximum = amount(range.maximumRaw);
  if (
    !Number.isInteger(cycles) ||
    cycles < 2 ||
    cycles > 25 ||
    total < BigInt(cycles) * minimum ||
    total > BigInt(cycles) * maximum
  )
    throw new Error(
      'The total DCA budget must fit every cycle within its minimum and maximum.',
    );
  return { total, minimum, maximum };
}
function random64(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(words[0]) << 32n) | BigInt(words[1]);
}
function uniform(span: bigint, random: () => bigint): bigint {
  if (span === 1n) return 0n;
  const cutoff = space - (space % span);
  for (let attempts = 0; attempts < 128; attempts++) {
    const value = random();
    if (typeof value !== 'bigint' || value < 0n || value >= space)
      throw new Error('Secure random allocation unavailable.');
    if (value < cutoff) return value % span;
  }
  throw new Error(
    'Secure random allocation unavailable. Retry generating the preview.',
  );
}
export function randomDcaAllocation(
  totalRaw: string,
  cycles: number,
  bounds: DcaRandomization,
  random: () => bigint = random64,
): string[] {
  const { total, minimum, maximum } = feasible(totalRaw, cycles, bounds);
  let remaining = total;
  const result: string[] = [];
  for (let i = 0; i < cycles; i++) {
    const after = BigInt(cycles - i - 1);
    const lo =
      remaining - after * maximum > minimum
        ? remaining - after * maximum
        : minimum;
    const hi =
      remaining - after * minimum < maximum
        ? remaining - after * minimum
        : maximum;
    const chosen = lo + uniform(hi - lo + 1n, random);
    result.push(chosen.toString());
    remaining -= chosen;
  }
  return result;
}
export function validateRandomDcaAllocation(
  totalRaw: string,
  cycles: number,
  bounds: DcaRandomization,
  values: unknown,
): string[] {
  const { total, minimum, maximum } = feasible(totalRaw, cycles, bounds);
  if (!Array.isArray(values) || values.length !== cycles)
    throw new Error('Generate and review every randomized DCA cycle.');
  let sum = 0n;
  for (const value of values) {
    const raw = amount(value);
    if (raw < minimum || raw > maximum)
      throw new Error(
        'Randomized DCA cycle is outside its saved amount bounds.',
      );
    sum += raw;
  }
  if (sum !== total)
    throw new Error(
      'Randomized DCA cycles must conserve the exact total budget.',
    );
  return values;
}
