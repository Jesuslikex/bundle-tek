'use client';

import { useState } from 'react';
import {
  Archive,
  ArrowRight,
  Copy,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  WalletCards,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CHAINS } from '@/lib/launch-plan';
import type { WorkspaceProject } from '@/lib/workspace-project';

export function ProjectDashboard({
  projects,
  archived = false,
  loading,
  busy,
  onOpen,
  onNew,
  onArchive,
  onDuplicate,
  onReload,
  onWallet,
}: {
  projects: WorkspaceProject[];
  archived?: boolean;
  loading: boolean;
  busy: boolean;
  onOpen: (project: WorkspaceProject) => void;
  onNew: () => void;
  onArchive: (project: WorkspaceProject) => void;
  onDuplicate: (project: WorkspaceProject) => void;
  onReload: () => void;
  onWallet: () => void;
}) {
  const [chain, setChain] = useState('All');
  const [search, setSearch] = useState('');
  const filtered = projects.filter(
    (p) =>
      p.archived === archived &&
      (chain === 'All' || p.plan.chain === chain) &&
      `${p.plan.tokenName} ${p.plan.ticker} ${p.plan.launchpad}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section className="project-dashboard">
      <header className="dashboard-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>{archived ? 'Archived projects' : 'Dashboard'}</h1>
          <p>
            {archived
              ? 'Restore a project whenever you want to continue.'
              : 'Your launch drafts, networks, and next steps in one place.'}
          </p>
        </div>
        <Button onClick={onNew} disabled={busy}>
          <Plus /> Create launch
        </Button>
      </header>
      {!archived && (
        <div className="dashboard-stats">
          <article>
            <span>Active drafts</span>
            <strong>{projects.filter((p) => !p.archived).length}</strong>
            <small>Saved projects</small>
          </article>
          <article>
            <span>Networks in your drafts</span>
            <strong>
              {
                new Set(
                  projects.filter((p) => !p.archived).map((p) => p.plan.chain),
                ).size
              }
            </strong>
            <small>Across 5 planning profiles</small>
          </article>
          <article>
            <span>Wallet workspace</span>
            <strong>Devnet</strong>
            <button onClick={onWallet}>
              Open wallet <ArrowRight size={14} />
            </button>
          </article>
          <article>
            <span>Mainnet launches</span>
            <strong>Unavailable</strong>
            <small>Execution integration required</small>
          </article>
        </div>
      )}
      <div className="project-toolbar">
        <Tabs value={chain} onValueChange={(v) => setChain(String(v))}>
          <TabsList aria-label="Filter projects by chain">
            {['All', ...CHAINS].map((value) => (
              <TabsTrigger value={value} key={value}>
                {value}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="project-search">
          <Search />
          <Input
            aria-label="Search projects"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects…"
          />
        </div>
        <Button
          variant="outline"
          onClick={onReload}
          disabled={loading || busy}
          aria-label="Reload projects"
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="project-table-wrap">
        <table className="project-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Network / launchpad</th>
              <th>Status</th>
              <th>Last saved</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((project) => (
              <tr key={project.id}>
                <td>
                  <button
                    aria-label={`Open ${project.plan.tokenName}`}
                    className="project-title-button"
                    onClick={() => onOpen(project)}
                    disabled={busy}
                  >
                    <span className="project-avatar">
                      {project.plan.ticker.slice(0, 2)}
                    </span>
                    <span>
                      <strong>{project.plan.tokenName}</strong>
                      <small>${project.plan.ticker}</small>
                    </span>
                  </button>
                </td>
                <td>
                  <strong>{project.plan.chain}</strong>
                  <small>{project.plan.launchpad}</small>
                </td>
                <td>
                  <span className="draft-badge">
                    {archived ? 'Archived' : 'Draft'}
                  </span>
                </td>
                <td>
                  <time dateTime={project.updatedAt}>
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </time>
                </td>
                <td>
                  <div className="project-row-actions">
                    <Button
                      variant="ghost"
                      aria-label={`Duplicate ${project.plan.tokenName}`}
                      onClick={() => onDuplicate(project)}
                      disabled={busy}
                    >
                      <Copy />
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`${archived ? 'Restore' : 'Archive'} ${project.plan.tokenName}`}
                      onClick={() => onArchive(project)}
                      disabled={busy}
                    >
                      {archived ? <RefreshCw /> : <Archive />}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="project-empty">
            <FolderOpen />
            <h2>
              {loading
                ? 'Loading projects…'
                : search || chain !== 'All'
                  ? 'No matching projects'
                  : archived
                    ? 'No archived projects'
                    : 'Your next launch starts here'}
            </h2>
            <p>
              {search || chain !== 'All'
                ? 'Try a different chain or search term.'
                : archived
                  ? 'Archived drafts will appear here.'
                  : 'Choose a chain, set up your token, and save a draft to your workspace.'}
            </p>
            {!loading && !archived && !search && chain === 'All' && (
              <Button onClick={onNew}>
                <Plus /> Create launch
              </Button>
            )}
          </div>
        )}
      </div>
      {!archived && (
        <section className="workspace-coverage">
          <h2>Workspace capabilities</h2>
          <div>
            <span>
              <FolderOpen />
              <strong>Launch planning</strong>
              <small>5 chains · 26 venue profiles · saved drafts</small>
            </span>
            <span>
              <WalletCards />
              <strong>Wallet verification</strong>
              <small>Solana devnet · message signing and memo test</small>
            </span>
            <span>
              <Search />
              <strong>Robinhood research</strong>
              <small>Token metadata inspector · Pons coordinator</small>
            </span>
          </div>
        </section>
      )}
    </section>
  );
}
