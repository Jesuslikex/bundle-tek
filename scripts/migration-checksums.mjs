import { createHash } from 'node:crypto';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Normalize physical SQL line endings only outside quoted literals/identifiers. Preserve every other byte, including invalid UTF8 and bare CR. */
function lineEndings(bytes, crlf = false) {
  const out = [];
  let state = 'code';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i],
      next = bytes[i + 1];
    const closing = { single: 39, double: 34, backtick: 96, bracket: 93 }[
      state
    ];
    if (closing !== undefined) {
      out.push(c);
      if (c === closing) {
        if (state !== 'bracket' && next === closing) {
          out.push(next);
          i++;
        } else state = 'code';
      }
      continue;
    }
    if (c === 10 || (c === 13 && next === 10)) {
      if (crlf) out.push(13);
      out.push(10);
      if (c === 13) i++;
      if (state === 'line') state = 'code';
      continue;
    }
    if (state === 'line') {
      out.push(c);
      continue;
    }
    if (state === 'block') {
      out.push(c);
      if (c === 42 && next === 47) {
        out.push(next);
        i++;
        state = 'code';
      }
      continue;
    }
    if ((c === 45 && next === 45) || (c === 47 && next === 42)) {
      out.push(c, next);
      i++;
      state = c === 45 ? 'line' : 'block';
      continue;
    }
    if (c === 39) state = 'single';
    else if (c === 34) state = 'double';
    else if (c === 96) state = 'backtick';
    else if (c === 91) state = 'bracket';
    out.push(c);
  }
  return Buffer.from(out);
}

/** New ledger entries are portable across Git/Windows checkouts without changing SQL string data. */
export const sqlMigrationChecksum = (bytes) => hash(lineEndings(bytes));

/** Accept exact bytes, equivalent outside-quote LF/CRLF, or an explicitly audited historical mixed-EOL checksum anchored to this exact canonical SQL. */
export function sqlMigrationChecksumMatches(bytes, applied, tag, aliases) {
  if (typeof applied !== 'string' || !/^[a-f0-9]{64}$/.test(applied))
    return false;
  const canonical = lineEndings(bytes),
    canonicalSha256 = hash(canonical);
  if (
    [hash(bytes), canonicalSha256, hash(lineEndings(canonical, true))].includes(
      applied,
    )
  )
    return true;
  if (
    aliases?.version !== 1 ||
    !aliases.migrations ||
    !Object.hasOwn(aliases.migrations, tag)
  )
    return false;
  const alias = aliases.migrations[tag];
  return (
    alias?.canonicalSha256 === canonicalSha256 &&
    Array.isArray(alias.legacySha256) &&
    alias.legacySha256.length > 0 &&
    alias.legacySha256.length <= 3 &&
    alias.legacySha256.every(
      (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    ) &&
    alias.legacySha256.includes(applied)
  );
}
