import { expect, it, vi } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  warmupSessionV2JournalFixture,
  v2JournalSignal as signal,
} from '@/test/warmup-session-v2-journal-fixture';
import { createWalletWarmupSessionProvider } from './wallet-warmup-session-provider';
import { createWalletWarmupSessionProviderCore } from './wallet-warmup-session-provider-core';
import { prepareWalletWarmupSessionAction } from './wallet-warmup-session-preparation';
import type { WarmupSessionPreparationCandidate } from './wallet-warmup-session-preparation';

it('only the reviewed server adapters and this boundary test may import the trusted provider core at runtime', () => {
  const importers = new Set<string>();
  for (const path of globSync(
    ['app', 'lib', 'components', 'db', 'test'].flatMap((root) => [
      `${root}/**/*.ts`,
      `${root}/**/*.tsx`,
    ]),
  )) {
    const text = readFileSync(path, 'utf8');
    // Avoid parsing thousands of unrelated modules during the full suite.
    if (!text.includes('wallet-warmup-session-provider-core')) continue;
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      let specifier: ts.Expression | undefined;
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
      )
        specifier = node.moduleSpecifier;
      else if (ts.isExportDeclaration(node) && !node.isTypeOnly)
        specifier = node.moduleSpecifier;
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      )
        specifier = node.arguments[0];
      if (
        specifier &&
        ts.isStringLiteralLike(specifier) &&
        /(?:^|\/)wallet-warmup-session-provider-core(?:\.ts)?$/.test(
          specifier.text,
        )
      )
        importers.add(path.replaceAll('\\', '/'));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect([...importers].sort()).toEqual([
    'lib/wallet-warmup-session-provider-version-isolation.test.ts',
    'lib/wallet-warmup-session-provider.ts',
    'lib/wallet-warmup-session-v2-provider.ts',
  ]);
});

it('a real owned v2 review cannot enter the legacy preparation service or start its provider', async () => {
  const f = await warmupSessionV2JournalFixture();
  try {
    await f.append('begin-review');
    const provider = vi.fn();
    await expect(
      prepareWalletWarmupSessionAction(
        f.db,
        'owner',
        {
          id: crypto.randomUUID(),
          journalId: f.journal.id,
          version: f.journal.version,
          headSha256: f.journal.headSha256,
        },
        signal(),
        provider,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider).not.toHaveBeenCalled();
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM warmup_swap_preparations')
        .first(),
    ).toEqual({ n: 0 });
    expect(f.journal.snapshot.phase).toBe('reviewing');
  } finally {
    f.client.close();
  }
});

it('the legacy snapshot adapter independently refuses a v2 candidate before cooldown, quote, inventory or simulation', async () => {
  const f = await warmupSessionV2JournalFixture();
  try {
    await f.append('begin-review');
    await f.db
      .prepare(
        'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
      )
      .run();
    const quote = vi.fn(),
      simulate = vi.fn(),
      inventory = vi.fn();
    const action = f.journal.snapshot.pendingReview;
    if (!action || action.side !== 'Buy')
      throw new Error('Expected synthetic Buy');
    const wallet = f.journal.manifest.wallets.find(
      (w) => w.wallet === action.wallet,
    );
    if (!wallet) throw new Error('Expected synthetic wallet');
    const candidate: WarmupSessionPreparationCandidate = {
      action,
      plan: f.plan,
      planDocument: JSON.stringify(f.plan.document),
      journalId: f.journal.id,
      version: f.journal.version,
      headSha256: f.journal.headSha256,
      deadline: Date.parse(f.consent.terms.sessionExpiresAt),
      budget: {
        buySpendLamports: wallet.buySpendLamports,
        recordedFurtherBuySpendLamports: '0',
        remainingReserveLamports: wallet.remainingFeeReserveLamports,
      },
      sellSource: null,
    };
    await expect(
      createWalletWarmupSessionProvider(f.db, 'owner', 'synthetic-key', {
        quote,
        simulate,
        inventory,
      })(candidate, signal()),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'Saved session, plan or wallets changed. Recover the current status.',
    });
    expect(quote).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_balance_gates')
        .first(),
    ).toEqual({ n: 0 });
    // A trusted future adapter still cannot replace the core's captured plan
    // by mutating its argument, even if it deliberately defeats readonly types.
    const mutatingReader = vi.fn(async (readValue) => {
      const mutable = readValue as WarmupSessionPreparationCandidate;
      mutable.planDocument = '{}';
      mutable.plan.document.addresses.length = 0;
      return { document: '{}', busy: 0 };
    });
    await expect(
      createWalletWarmupSessionProviderCore(
        f.db,
        'owner',
        'synthetic-key',
        mutatingReader,
        { quote, simulate, inventory },
      )(candidate, signal()),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'Saved session, plan or wallets changed. Recover the current status.',
    });
    expect(mutatingReader).toHaveBeenCalledOnce();
    expect(candidate.planDocument).toBe(JSON.stringify(f.plan.document));
    expect(candidate.plan.document.addresses).toContain(action.wallet);
    expect(quote).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_balance_gates')
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM warmup_swap_preparations')
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    f.client.close();
  }
});
