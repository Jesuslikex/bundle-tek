'use client';

import { useId, useState } from 'react';
import { Folder, Settings } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { FOLDER_COLORS } from '@/lib/wallet-workspace';

export function WalletFolderColorPicker({
  color,
  onChange,
  disabled,
}: {
  color: string;
  onChange: (color: string) => void;
  disabled: boolean;
}) {
  const inputId = useId();
  const [custom, setCustom] = useState(
    !FOLDER_COLORS.some((preset) => preset === color),
  );
  const showCustom =
    custom || !FOLDER_COLORS.some((preset) => preset === color);
  return (
    <fieldset className="wallet-folder-color-picker" disabled={disabled}>
      <legend>Folder style</legend>
      <div className="wallet-folder-color-options">
        {FOLDER_COLORS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            aria-label={`Folder color ${preset}`}
            aria-pressed={!showCustom && color === preset}
            style={{ color: preset }}
            onClick={() => {
              onChange(preset);
              setCustom(false);
            }}
          >
            <Folder size={20} />
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          aria-label="Custom folder color"
          aria-pressed={showCustom}
          style={
            showCustom && /^#[0-9A-F]{6}$/.test(color) ? { color } : undefined
          }
          onClick={() => setCustom(true)}
        >
          <Settings size={20} />
        </button>
      </div>
      {showCustom && (
        <label htmlFor={inputId}>
          Custom color
          <Input
            id={inputId}
            aria-label="Custom folder color hex"
            placeholder="A6B1FF"
            maxLength={7}
            value={color.replace(/^#/, '')}
            pattern="[0-9a-fA-F]{6}"
            required
            disabled={disabled}
            onChange={(event) =>
              onChange(`#${event.target.value.replace(/^#/, '').toUpperCase()}`)
            }
          />
        </label>
      )}
    </fieldset>
  );
}
