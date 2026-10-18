'use client';
import { useId } from 'react';
import { Input } from './ui/input';
import { parseDurationParts, type DurationParts } from '@/lib/duration-parts';
import styles from './duration-input.module.css';

export function DurationInput({
  label,
  value,
  onChange,
  disabled,
  maximumSeconds,
  emptyLabel = 'Set a duration to review its exact total.',
}: {
  label: string;
  value: DurationParts;
  onChange: (value: DurationParts) => void;
  disabled?: boolean;
  maximumSeconds?: number;
  emptyLabel?: string;
}) {
  const id = useId();
  const parsed = parseDurationParts(value, maximumSeconds);
  const entered = Object.values(value).some((part) => part !== '');
  const invalid = entered && parsed.seconds === null;
  return (
    <fieldset
      className={styles.field}
      disabled={disabled}
      aria-describedby={`${id}-result`}
    >
      <legend>{label}</legend>
      <div className={styles.units}>
        {(['hours', 'minutes', 'seconds'] as const).map((unit) => (
          <label key={unit} htmlFor={`${id}-${unit}`}>
            {unit === 'hours'
              ? 'Hours'
              : unit === 'minutes'
                ? 'Minutes'
                : 'Seconds'}
            <Input
              id={`${id}-${unit}`}
              aria-label={`${label}: ${unit}`}
              inputMode="numeric"
              placeholder="0"
              maxLength={16}
              value={value[unit]}
              aria-invalid={invalid}
              onChange={(event) =>
                onChange({ ...value, [unit]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      {invalid ? (
        <p id={`${id}-result`} role="alert" className={styles.error}>
          {parsed.error}
        </p>
      ) : (
        <output id={`${id}-result`} aria-live="polite">
          {parsed.seconds === null
            ? emptyLabel
            : `${parsed.seconds.toLocaleString('en-US')} seconds total`}
        </output>
      )}
    </fieldset>
  );
}
