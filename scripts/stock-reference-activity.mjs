import { createHash } from 'node:crypto';

export function referenceActivity(rows, observedSlot) {
  if (
    !Number.isSafeInteger(observedSlot) ||
    observedSlot < 1 ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0]?.slot !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(rows[0].slot) ||
    !Number.isSafeInteger(Number(rows[0].slot)) ||
    Number(rows[0].slot) > observedSlot ||
    typeof rows[0].signature !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(rows[0].signature)
  )
    throw Error('Public reference activity evidence is unavailable.');
  return {
    observedSlot,
    latestActivitySlot: rows[0].slot,
    latestSignatureSha256: createHash('sha256')
      .update(rows[0].signature)
      .digest('hex'),
    idleSlots: observedSlot - Number(rows[0].slot),
  };
}

export function unchangedQuietReference(before, after) {
  const valid = (value) =>
    value &&
    Number.isSafeInteger(value.observedSlot) &&
    typeof value.latestActivitySlot === 'string' &&
    /^[1-9]\d{0,15}$/.test(value.latestActivitySlot) &&
    Number.isSafeInteger(Number(value.latestActivitySlot)) &&
    Number(value.latestActivitySlot) <= value.observedSlot &&
    value.idleSlots === value.observedSlot - Number(value.latestActivitySlot) &&
    typeof value.latestSignatureSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.latestSignatureSha256);
  return (
    valid(before) &&
    valid(after) &&
    before.idleSlots >= 256 &&
    after.observedSlot >= before.observedSlot &&
    after.latestActivitySlot === before.latestActivitySlot &&
    after.latestSignatureSha256 === before.latestSignatureSha256
  );
}
