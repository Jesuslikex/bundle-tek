import bs58 from 'bs58';
import type { SwapInstructionReview } from './swap-instruction-review';
function index(v: unknown, bound: number) {
  const n =
    typeof v === 'string' && /^(0|[1-9]\d{0,3})$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n >= bound)
    throw Error('Pair runtime trace index differs.');
  return n;
}
function canonical(v: unknown, depth = 0): unknown {
  if (depth > 10) throw Error('Pair runtime parsed instruction is too deep.');
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string' && v.length <= 8192) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length <= 512)
    return v.map((x) => canonical(x, depth + 1));
  if (v && typeof v === 'object' && Object.keys(v).length <= 128)
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x, depth + 1)]),
    );
  throw Error('Pair runtime parsed instruction is not bounded JSON.');
}
export async function pairRuntimeDigest(value: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical(value)));
  if (encoded.length > 524288)
    throw Error('Pair runtime evidence is too large.');
  return Buffer.from(await crypto.subtle.digest('SHA-256', encoded)).toString(
    'hex',
  );
}
/** RPC reports compiled, partially decoded, or parsed inner instructions. Parsed labels are evidence, never raw instruction verification. */
export async function reviewPairRuntimeTrace(
  raw: unknown,
  top: SwapInstructionReview,
  keys: string[],
  writable: string[],
) {
  if (
    !Array.isArray(raw) ||
    raw.length > top.instructions.length ||
    !keys.length ||
    keys.length > 256 ||
    new Set(keys).size !== keys.length
  )
    throw Error('Pair runtime trace is missing or outside scope.');
  const calls: {
    topIndex: number;
    ordinal: number;
    program: string;
    parentProgram: string;
    stackHeight: number;
    accounts: string[] | null;
    dataBase58: string | null;
    parsedType: string | null;
    parsedSha256: string | null;
  }[] = [];
  let priorIndex = -1;
  for (const group of raw) {
    const g = group as { index?: unknown; instructions?: unknown };
    const topIndex = index(g?.index, top.instructions.length);
    if (
      topIndex <= priorIndex ||
      !Array.isArray(g.instructions) ||
      !g.instructions.length ||
      g.instructions.length > 512
    )
      throw Error('Pair runtime trace grouping differs.');
    priorIndex = topIndex;
    const parents = [top.instructions[topIndex].program.address];
    let height = 1;
    for (const [ordinal, item] of g.instructions.entries()) {
      if (calls.length >= 512)
        throw Error('Pair runtime trace call budget exceeded.');
      const v = item as Record<string, unknown>;
      const nextHeight = index(v?.stackHeight, 65);
      if (nextHeight < 2 || nextHeight > height + 1)
        throw Error('Pair runtime trace stack differs.');
      height = nextHeight;
      const names = Object.keys(v).sort().join(',');
      let program: string,
        accounts: string[] | null = null,
        data: string | null = null,
        parsedType: string | null = null,
        parsedSha256: string | null = null;
      if (
        names === 'accounts,data,programIdIndex,stackHeight' ||
        names === 'accounts,data,programId,stackHeight'
      ) {
        program = names.includes('programIdIndex')
          ? keys[index(v.programIdIndex, keys.length)]
          : String(v.programId);
        if (
          !Array.isArray(v.accounts) ||
          v.accounts.length > 256 ||
          typeof v.data !== 'string' ||
          v.data.length > 16384
        )
          throw Error('Pair runtime instruction fields differ.');
        accounts = v.accounts.map((a) =>
          names.includes('programIdIndex')
            ? keys[index(a, keys.length)]
            : String(a),
        );
        const bytes = bs58.decode(v.data);
        if (bs58.encode(bytes) !== v.data || bytes.length > 10240)
          throw Error('Pair runtime instruction encoding differs.');
        data = v.data;
      } else if (names === 'parsed,program,programId,stackHeight') {
        program = String(v.programId);
        const parsed = v.parsed as { type?: unknown; info?: unknown };
        if (
          typeof v.program !== 'string' ||
          !v.program.length ||
          v.program.length > 64 ||
          typeof parsed?.type !== 'string' ||
          !parsed.type.length ||
          parsed.type.length > 128 ||
          !parsed.info ||
          typeof parsed.info !== 'object' ||
          Array.isArray(parsed.info)
        )
          throw Error('Pair runtime parsed instruction fields differ.');
        parsedType = parsed.type;
        parsedSha256 = await pairRuntimeDigest(v.parsed);
      } else throw Error('Pair runtime instruction profile differs.');
      if (
        !keys.includes(program) ||
        writable.includes(program) ||
        accounts?.some((a) => !keys.includes(a))
      )
        throw Error('Pair runtime program or account is outside the packet.');
      const parentProgram = parents[height - 2];
      if (!parentProgram) throw Error('Pair runtime trace parent differs.');
      parents.length = height - 1;
      parents.push(program);
      calls.push({
        topIndex,
        ordinal,
        program,
        parentProgram,
        stackHeight: height,
        accounts,
        dataBase58: data,
        parsedType,
        parsedSha256,
      });
    }
  }
  const routeIndex = top.instructions.find(
    (i) => i.program.address === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )?.index;
  if (routeIndex === undefined || !calls.some((c) => c.topIndex === routeIndex))
    throw Error('Pair runtime route inner calls are missing.');
  const report = {
    format: 'pair-runtime-trace-v1' as const,
    calls,
    programs: [
      ...new Set([
        ...top.instructions.map((i) => i.program.address),
        ...calls.map((c) => c.program),
      ]),
    ].sort(),
    parsedInstructionCount: calls.filter((c) => c.parsedType !== null).length,
    rawInstructionCoverageComplete: calls.every((c) => c.dataBase58 !== null),
    providerObservationOnly: true as const,
    innerInstructionPolicyVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  return { ...report, sha256: await pairRuntimeDigest(report) };
}
