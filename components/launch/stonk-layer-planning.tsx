'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VAULT_MIN_PASSWORD_LENGTH } from '@/lib/browser-wallet-vault';
import {
  createPumpMint,
  parsePumpMintBackup,
  persistPumpMint,
  pumpMintStorageKey,
  type PumpMintBackup,
} from '@/lib/pump-mint-vault';
import { LaunchLayerPlanningEntry } from './launch-layer-planning-entry';
import styles from './pump-launch-ui.module.css';

type Props = { project: { id: string; updatedAt: string }; disabled?: boolean };
function Planning({ project, disabled = false }: Props) {
  const id = useId();
  const [mint, setMint] = useState<PumpMintBackup | null>(null);
  const [password, setPassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => {
      try {
        const value = localStorage.getItem(pumpMintStorageKey(project.id));
        if (value) setMint(parsePumpMintBackup(value, project.id));
      } catch {
        setError(
          'Saved mint candidate is unavailable. Restore this project’s encrypted backup.',
        );
      }
      setReady(true);
    }, 0);
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [project.id]);
  async function retain(restore: boolean) {
    if (
      pending.current ||
      disabled ||
      !ready ||
      mint ||
      (restore ? !file : password.length < VAULT_MIN_PASSWORD_LENGTH)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError('');
    const pass = password,
      backupFile = file;
    setPassword('');
    try {
      let candidate: PumpMintBackup;
      if (restore) {
        if (!backupFile || backupFile.size > 400000)
          throw Error(
            'Choose this project’s encrypted mint backup (up to 400 KB).',
          );
        const text = await backupFile.text();
        if (!alive.current) return;
        candidate = parsePumpMintBackup(text, project.id);
      } else candidate = await createPumpMint(project.id, pass);
      if (!alive.current) return;
      await persistPumpMint(candidate, () => alive.current);
      if (!alive.current) return;
      setMint(candidate);
      setFile(null);
    } catch {
      if (alive.current)
        setError(
          'Mint candidate could not be saved. Restore this project’s encrypted backup or retry. Existing saved keys are not replaced.',
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function download() {
    if (!mint || disabled || busy) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(mint)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'bundle-mint-' + project.id + '.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  const blocked = disabled || busy || !ready;
  return (
    <section
      className={styles.panel}
      aria-label="StonkFun Front-wallet planning"
    >
      <h3>StonkFun Front-wallet planning</h3>
      <p>
        Plan up to 12 Front wallets. StonkFun has no Back or temporary layer.
        Coin creation, funding and signing are not available from this planner.
      </p>
      {!ready && <output>Checking saved mint candidate…</output>}
      {mint ? (
        <>
          <p className={styles.wrap}>
            Mint candidate: <code>{mint.mint}</code>
          </p>
          <p>
            This is the public address from the encrypted backup. Planning does
            not decrypt it or prove key control.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={blocked}
            onClick={download}
          >
            Download encrypted mint backup
          </Button>
          <LaunchLayerPlanningEntry
            selection={{
              projectId: project.id,
              projectUpdatedAt: project.updatedAt,
              target: { kind: 'new', mint: mint.mint },
            }}
            disabled={blocked}
            frontOnly
          />
        </>
      ) : (
        <>
          <label htmlFor={id + '-password'}>
            Mint backup password (at least {VAULT_MIN_PASSWORD_LENGTH}{' '}
            characters)
          </label>
          <Input
            id={id + '-password'}
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={blocked}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            type="button"
            disabled={blocked || password.length < VAULT_MIN_PASSWORD_LENGTH}
            onClick={() => void retain(false)}
          >
            Generate encrypted mint candidate
          </Button>
          <label htmlFor={id + '-restore'}>
            Or choose this project’s encrypted mint backup
          </label>
          <Input
            id={id + '-restore'}
            type="file"
            accept=".json,application/json"
            disabled={blocked}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={blocked || !file}
            onClick={() => void retain(true)}
          >
            Restore public mint candidate
          </Button>
          <p>
            Restoring reads the backup’s public address and encrypted envelope
            only. Keep its password and a downloaded backup for any future
            supported signing flow.
          </p>
        </>
      )}
      <div aria-live="polite">
        {busy && <p>Saving encrypted mint candidate…</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
export function StonkLayerPlanning(props: Props) {
  return <Planning key={JSON.stringify(props.project)} {...props} />;
}
