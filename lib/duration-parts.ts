export type DurationParts = { hours: string; minutes: string; seconds: string };

export function splitDurationSeconds(seconds: number): DurationParts {
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new Error('Duration must be a non-negative safe integer.');
  const raw = BigInt(seconds);
  return {
    hours: String(raw / 3600n),
    minutes: String((raw % 3600n) / 60n),
    seconds: String(raw % 60n),
  };
}

/** Invalid edits stay invalid; never carry excess minutes or seconds silently. */
export function parseDurationParts(
  parts: DurationParts,
  maximumSeconds = Number.MAX_SAFE_INTEGER,
): { seconds: number | null; error: string } {
  if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 1)
    throw new Error('Choose a positive safe integer duration limit.');
  const values = [parts.hours, parts.minutes, parts.seconds];
  if (values.every((part) => part === ''))
    return { seconds: null, error: 'Enter hours, minutes or seconds.' };
  if (values.some((part) => part !== '' && !/^\d{1,16}$/.test(part)))
    return {
      seconds: null,
      error: 'Use non-negative whole numbers for each time unit.',
    };
  const [hours, minutes, seconds] = values.map((part) => BigInt(part || '0'));
  if (minutes > 59n || seconds > 59n)
    return {
      seconds: null,
      error: 'Minutes and seconds must each be from 0 to 59.',
    };
  const total = hours * 3600n + minutes * 60n + seconds;
  if (total < 1n || total > BigInt(maximumSeconds))
    return {
      seconds: null,
      error: `Choose a duration from 1 to ${maximumSeconds.toLocaleString('en-US')} seconds.`,
    };
  return { seconds: Number(total), error: '' };
}
