import { describe, expect, it } from 'vitest';
import { persistWatchedWallet } from './supply-watch-wallet';
import type { ImportedTokenProject } from './imported-token-project';
import type { WorkspaceWallet } from './wallet-workspace';
import { supplyWallet } from '../test/supply-history-fixture';

const owner = supplyWallet(7);
const project = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'project-1',
    revision: 1,
    archived: false,
    updatedAt: '',
    document: {
      token: {
        chain: 'Solana',
        address: supplyWallet(9),
        name: 'Token',
        symbol: 'TKN',
        decimals: 6,
      },
    },
    ...overrides,
  }) as unknown as ImportedTokenProject;

const savedRecord = (overrides: Partial<WorkspaceWallet> = {}) =>
  ({
    chain: 'Solana',
    address: owner,
    folderId: '',
    label: 'Holder 0000',
    role: 'Recipient',
    archived: false,
    revision: 3,
    updatedAt: '2026-10-12T10:00:00.000Z',
    ...overrides,
  }) as WorkspaceWallet;

type AddBody = {
  action: string;
  chain: string;
  wallets: { address: string; label: string; role: string }[];
};

// A minimal stand-in for /api/wallet-workspace: GET returns the roster and
// wallet.add inserts a server-timestamped record unless onAdd overrides it.
function workspace(
  initial: WorkspaceWallet[] = [],
  onAdd?: (body: AddBody, save: () => void) => Response | null,
) {
  let roster = [...initial];
  const calls: { method: string; body?: AddBody }[] = [];
  const request = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as AddBody)
        : undefined;
    calls.push({ method, body });
    if (method === 'GET') return Response.json({ wallets: roster });
    const save = () => {
      const entry = body!.wallets[0];
      roster = [
        ...roster,
        savedRecord({
          address: entry.address,
          label: entry.label,
          revision: 1,
          updatedAt: '2026-10-12T11:00:00.000Z',
        }),
      ];
    };
    const override = onAdd?.(body!, save);
    if (override) return override;
    save();
    return Response.json({ changed: 1 });
  }) as typeof fetch;
  return {
    request,
    calls,
    adds: () => calls.filter((c) => c.method === 'POST'),
  };
}

describe('persistWatchedWallet', () => {
  it('saves the public address before returning and uses the server record', async () => {
    const ws = workspace();
    const wallet = await persistWatchedWallet(project(), owner, ws.request);
    const [add] = ws.adds();
    expect(add.body).toEqual({
      action: 'wallet.add',
      chain: 'Solana',
      wallets: [
        {
          address: owner,
          label: `Holder ${owner.slice(0, 6)}`,
          role: 'Recipient',
        },
      ],
    });
    expect(ws.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(wallet).toMatchObject({
      address: owner,
      chain: 'Solana',
      role: 'Recipient',
      archived: false,
      revision: 1,
      updatedAt: '2026-10-12T11:00:00.000Z',
    });
  });

  it('reuses an existing active record without writing again', async () => {
    const existing = savedRecord();
    const ws = workspace([existing]);
    const wallet = await persistWatchedWallet(project(), owner, ws.request);
    expect(wallet).toEqual(existing);
    expect(ws.adds()).toHaveLength(0);
  });

  it('refuses an archived record and never unarchives it', async () => {
    const ws = workspace([savedRecord({ archived: true })]);
    await expect(
      persistWatchedWallet(project(), owner, ws.request),
    ).rejects.toThrow(/archived in your wallet roster/);
    expect(ws.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('surfaces a server rejection and returns no wallet', async () => {
    const ws = workspace([], () =>
      Response.json(
        { error: 'Wallet storage temporarily unavailable.' },
        { status: 503 },
      ),
    );
    await expect(
      persistWatchedWallet(project(), owner, ws.request),
    ).rejects.toThrow('Wallet storage temporarily unavailable.');
  });

  it('reuses the record when a concurrent save of the same address wins', async () => {
    const ws = workspace([], (_body, save) => {
      save();
      return Response.json({ error: 'Nothing changed.' }, { status: 409 });
    });
    const wallet = await persistWatchedWallet(project(), owner, ws.request);
    expect(wallet.address).toBe(owner);
    expect(ws.adds()).toHaveLength(1);
  });

  it('reports a 409 that did not produce an active record (e.g. the 500-wallet cap)', async () => {
    const ws = workspace([], () =>
      Response.json(
        { error: 'Nothing changed. Reload to check revisions.' },
        { status: 409 },
      ),
    );
    await expect(
      persistWatchedWallet(project(), owner, ws.request),
    ).rejects.toThrow('Nothing changed. Reload to check revisions.');
  });

  it('does not select a wallet the roster cannot confirm after a successful save', async () => {
    const ws = workspace([], () => Response.json({ changed: 1 }));
    await expect(
      persistWatchedWallet(project(), owner, ws.request),
    ).rejects.toThrow('could not be confirmed');
  });

  it('rejects invalid addresses, archived projects and non-Solana projects before any request', async () => {
    const ws = workspace();
    await expect(
      persistWatchedWallet(project(), 'not-an-address', ws.request),
    ).rejects.toThrow();
    await expect(
      persistWatchedWallet(project({ archived: true }), owner, ws.request),
    ).rejects.toThrow(/Archived projects/);
    await expect(
      persistWatchedWallet(
        project({
          document: {
            token: { chain: 'Robinhood', address: '0x1', name: 'T' },
          },
        }),
        owner,
        ws.request,
      ),
    ).rejects.toThrow(/Solana projects/);
    expect(ws.calls).toHaveLength(0);
  });
});
