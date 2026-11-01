'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VolumeBotPanel } from '@/components/volume-bot-panel';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';

// The captured roster action opens fake-volume sessions, but the volume bot is
// only mountable for an imported project. This bridges the two: pick the token
// the volume should trade, then run the existing panel against it.
export function VolumeBotLauncher({
  wallets,
  locked,
  onClose,
}: {
  wallets: WorkspaceWallet[];
  locked: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const [projects, setProjects] = useState<ImportedTokenProject[] | null>(null);
  const [chosen, setChosen] = useState<ImportedTokenProject | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/imported-projects', {
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as {
          projects?: ImportedTokenProject[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error || 'Imported tokens unavailable.');
        setProjects(
          (body.projects ?? []).filter(
            (project) =>
              project.document.token.chain === 'Solana' && !project.archived,
          ),
        );
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Imported tokens unavailable.',
          );
      }
    })();
    return () => controller.abort();
  }, []);

  const name = useCallback(
    (project: ImportedTokenProject) =>
      project.document.token.name || project.document.token.address,
    [],
  );

  const visible = (projects ?? []).filter((project) =>
    name(project).toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="wallet-folder-editor-dialog">
        <DialogHeader>
          <DialogTitle>Generate activity</DialogTitle>
          <DialogDescription>
            {chosen
              ? 'Set the volume target below. Nothing sends until you approve'
              : 'Pick the imported Solana token to generate volume on.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="tracker-error">
            {error}
          </p>
        )}

        {chosen ? (
          <>
            <div className="volume-launcher-head">
              <strong>{name(chosen)}</strong>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setChosen(null)}
              >
                Change token
              </Button>
            </div>
            <VolumeBotPanel
              project={chosen}
              wallets={wallets}
              locked={locked}
            />
          </>
        ) : projects === null ? (
          <p className="volume-launcher-note">Loading tokens…</p>
        ) : projects.length === 0 ? (
          <p className="volume-launcher-note">
            No imported Solana tokens yet. Import a token first, then generate
            volume on it.
          </p>
        ) : (
          <>
            <label htmlFor={`${id}-search`}>
              Search tokens
              <Input
                id={`${id}-search`}
                aria-label="Search imported tokens"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <ul className="volume-launcher-list">
              {visible.map((project) => (
                <li key={project.id}>
                  <button type="button" onClick={() => setChosen(project)}>
                    <span>{name(project)}</span>
                    <code>{project.document.token.address}</code>
                  </button>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="volume-launcher-note">No tokens match.</li>
              )}
            </ul>
          </>
        )}

        <div className="wallet-folder-editor-actions">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
