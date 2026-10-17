'use client';

import { ReferralPanel } from './referral-panel';
import { useState } from 'react';
import {
  Archive,
  ArrowRight,
  Copy,
  FolderOpen,
  LogIn,
  Plus,
  RefreshCw,
  Search,
  WalletCards,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CHAINS, CURRENT_VENUES_BY_CHAIN } from '@/lib/launch-plan';
import type { WorkspaceProject } from '@/lib/workspace-project';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { AccountCostsPanel } from '@/components/account-costs';
import { AccountPerformancePanel } from '@/components/account-performance';

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
  imports = [],
  importsLoading = false,
  importsError = '',
  onOpenImport,
  onImport,
  signedOut = false,
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
  imports?: ImportedTokenProject[];
  importsLoading?: boolean;
  importsError?: string;
  onOpenImport?: (id: string) => void;
  /** Starts a new token import. */
  onImport?: () => void;
  /** Saved drafts and imports cannot be read; counts and empty states would mislead. */
  signedOut?: boolean;
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
  const filteredImports = imports.filter(
    (p) =>
      p.archived === archived &&
      (chain === 'All' || p.document.token.chain === chain) &&
      `${p.document.token.name} ${p.document.token.symbol} ${p.document.token.chain} ${p.document.token.address}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
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
              : 'Your launch drafts, imported tokens and next steps in one place.'}
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
            <strong>
              {signedOut ? '—' : projects.filter((p) => !p.archived).length}
            </strong>
            <small>{signedOut ? 'Sign in to load' : 'Saved projects'}</small>
          </article>
          <article>
            <span>Networks in your drafts</span>
            <strong>
              {signedOut
                ? '—'
                : new Set(
                    projects
                      .filter((p) => !p.archived)
                      .map((p) => p.plan.chain),
                  ).size}
            </strong>
            <small>Across {CHAINS.length} planning profiles</small>
          </article>
          <article>
            <span>Wallet workspace</span>
            <strong>{CHAINS.length} networks</strong>
            <button onClick={onWallet}>
              Open wallets <ArrowRight size={14} />
            </button>
          </article>
          <article>
            <span>Imported tokens</span>
            <strong>
              {signedOut || importsLoading
                ? '—'
                : imports.filter((p) => !p.archived).length}
            </strong>
            {onImport && !signedOut ? (
              <button onClick={onImport} disabled={busy}>
                Import token <ArrowRight size={14} />
              </button>
            ) : (
              <small>{signedOut ? 'Sign in to load' : 'Saved imports'}</small>
            )}
          </article>
        </div>
      )}
      {!archived && <AccountPerformancePanel />}
      {!archived && !signedOut && <ReferralPanel />}
      {!archived && <AccountCostsPanel />}
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
          disabled={loading || importsLoading || busy}
          aria-label="Reload projects"
        >
          <RefreshCw />
        </Button>
      </div>
      <h2 className="library-section-title">Launch drafts</h2>
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
        {signedOut && !archived && (
          <div className="project-empty">
            <LogIn />
            <h2>Sign in to open your workspace</h2>
            <p>
              Launch drafts and imported tokens are saved to your account. You
              can still plan a launch, but it will not be saved until you sign
              in.
            </p>
            {/* oxlint-disable-next-line next/no-html-link-for-pages -- Sites sign-in must use a top-level document navigation. */}
            <a className={buttonVariants()} href="/sign-in" target="_top">
              <LogIn /> Sign in
            </a>
          </div>
        )}
        {!(signedOut && !archived) &&
          filtered.length === 0 &&
          filteredImports.length === 0 && (
            <div className="project-empty">
              <FolderOpen />
              <h2>
                {loading
                  ? 'Loading projects…'
                  : search || chain !== 'All'
                    ? 'No matching launch drafts'
                    : archived
                      ? 'No archived launch drafts'
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
        {filtered.length === 0 && filteredImports.length > 0 && (
          <p className="library-empty-note">
            No launch drafts match this view.
          </p>
        )}
      </div>
      <section
        aria-label="Imported token library"
        className="imported-token-library"
      >
        <h2>Imported tokens</h2>
        {signedOut ? (
          <p>Sign in to load your imported tokens.</p>
        ) : (
          <>
            <p>
              {importsLoading
                ? 'Loading saved imports…'
                : `${imports.filter((p) => p.archived === archived).length} ${archived ? 'archived' : 'active'} imports. Opening an import shows its latest saved identity and settings.`}
            </p>
            {importsError && (
              <p role="alert">
                {importsError} Previously loaded imports may be stale.
              </p>
            )}
          </>
        )}
        {!signedOut && (
          <div className="project-table-wrap">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Network / address</th>
                  <th>Status</th>
                  <th>Last saved</th>
                </tr>
              </thead>
              <tbody>
                {filteredImports.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <button
                        className="project-title-button"
                        aria-label={`Open imported ${project.document.token.name}`}
                        disabled={busy || !onOpenImport}
                        onClick={() => onOpenImport?.(project.id)}
                      >
                        <span className="project-avatar">
                          {project.document.token.symbol.slice(0, 2)}
                        </span>
                        <span>
                          <strong>{project.document.token.name}</strong>
                          <small>
                            ${project.document.token.symbol} · r
                            {project.revision}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <strong>{project.document.token.chain}</strong>
                      <small className="warmup-address">
                        {project.document.token.address}
                      </small>
                    </td>
                    <td>
                      <span className="draft-badge">
                        {project.archived ? 'Archived import' : 'Import'}
                      </span>
                    </td>
                    <td>
                      <time dateTime={project.updatedAt}>
                        {new Date(project.updatedAt).toLocaleDateString()}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredImports.length && !importsLoading && (
              <p className="library-empty-note">
                {importsError
                  ? 'Reload projects to check saved imports.'
                  : search || chain !== 'All'
                    ? 'No imports match this search and network.'
                    : `No ${archived ? 'archived' : 'active'} imports.`}
              </p>
            )}
            {!filteredImports.length &&
              !importsLoading &&
              !importsError &&
              !archived &&
              !search &&
              chain === 'All' &&
              onImport && (
                <div className="library-empty-action">
                  <span>
                    Paste a token address to open its chart, holders and trading
                    tools.
                  </span>
                  <Button variant="outline" onClick={onImport} disabled={busy}>
                    <Plus /> Import token
                  </Button>
                </div>
              )}
          </div>
        )}
      </section>
      {!archived && (
        <section className="workspace-coverage">
          <h2>Workspace capabilities</h2>
          <div>
            <span>
              <FolderOpen />
              <strong>Launch planning</strong>
              <small>
                {CHAINS.length} chains ·{' '}
                {Object.values(CURRENT_VENUES_BY_CHAIN).flat().length} venue
                profiles · saved drafts
              </small>
            </span>
            <span>
              <WalletCards />
              <strong>Wallet verification</strong>
              <small>EVM ownership messages · Solana devnet tools</small>
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
