import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyReleasedLaunchIdentity } from './released-launch-identity';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
  type ProjectDocument,
} from './workspace-project';

const origin = 'https://bundle.test';
const releaseId = 'a'.repeat(64);
const uri = `${origin}/api/launch/metadata/${releaseId}`;
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  ),
);
const imageId = createHash('sha256').update(png).digest('hex');

function fixture() {
  const current = validateProjectDocument({
    plan: {
      ...structuredClone(DEFAULT_LAUNCH_PLAN),
      tokenName: 'RípéMon 🐒',
      ticker: 'RIPMON',
      description: 'UTF-8 public identity: 漢字 and café',
    },
    identity: {
      ...EMPTY_IDENTITY,
      artworkUrl: '/api/artwork/' + imageId,
      website: 'https://example.test/site',
      twitter: 'https://example.test/social',
      telegram: 'https://example.test/chat',
    },
    options: structuredClone(DEFAULT_VENUE_OPTIONS),
  });
  const metadata = {
    name: current.plan.tokenName,
    symbol: current.plan.ticker,
    description: current.plan.description,
    website: current.identity.website,
    twitter: current.identity.twitter,
    telegram: current.identity.telegram,
    image: `${uri}/image`,
    properties: {
      files: [{ uri: `${uri}/image`, type: 'image/png' }],
      category: 'image',
    },
  };
  const release = {
    source_document: JSON.stringify(current),
    metadata: JSON.stringify(metadata),
    image: Array.from(png),
    mime: 'image/png',
  };
  return { current, metadata, release };
}
function verify(f: ReturnType<typeof fixture>, site = origin, id = releaseId) {
  return verifyReleasedLaunchIdentity(f.current, f.release, site, id);
}

it('binds UTF-8 identity to actual PNG bytes, saved source and selected public URI', async () => {
  const f = fixture();
  expect(await verify(f)).toEqual({
    name: 'RípéMon 🐒',
    symbol: 'RIPMON',
    uri,
  });
  expect(imageId).not.toBe(
    createHash('sha256')
      .update(Buffer.from(png).toString('base64'))
      .digest('hex'),
  );
});

const identityChanges: [string, (doc: ProjectDocument) => void][] = [
  [
    'name',
    (doc) => {
      doc.plan.tokenName = 'Another token';
    },
  ],
  [
    'symbol',
    (doc) => {
      doc.plan.ticker = 'OTHER';
    },
  ],
  [
    'description',
    (doc) => {
      doc.plan.description = 'Another description';
    },
  ],
  [
    'artwork',
    (doc) => {
      doc.identity.artworkUrl = '/api/artwork/' + 'b'.repeat(64);
    },
  ],
  [
    'website',
    (doc) => {
      doc.identity.website = 'https://changed.test/site';
    },
  ],
  [
    'twitter',
    (doc) => {
      doc.identity.twitter = 'https://changed.test/social';
    },
  ],
  [
    'telegram',
    (doc) => {
      doc.identity.telegram = 'https://changed.test/chat';
    },
  ],
];
it.each(identityChanges)(
  'rejects changed current %s against the released source',
  async (_label, change) => {
    const f = fixture();
    change(f.current);
    await expect(verify(f)).rejects.toThrow('exact saved identity and image');
  },
);
it.each(identityChanges)(
  'rejects changed released-source %s against the current project',
  async (_label, change) => {
    const f = fixture();
    const source = structuredClone(f.current);
    change(source);
    f.release.source_document = JSON.stringify(source);
    await expect(verify(f)).rejects.toThrow('exact saved identity and image');
  },
);

it('permits funding, wallet-selection, timing and unrelated venue-option edits', async () => {
  const f = fixture();
  const before = structuredClone(f.release);
  f.current.plan.developerBuy = 2;
  f.current.plan.holdersBuy = 1;
  f.current.plan.holderCount = 3;
  f.current.plan.scheduled = true;
  f.current.options.creatorTax = 0;
  f.current.options.buyback = true;
  f.current.options.wallets = {
    chain: 'Solana',
    recipients: [
      {
        address: 'SysvarRent111111111111111111111111111111111',
        revision: 1,
        folderRevision: 0,
      },
    ],
  };
  expect(await verify(f)).toEqual({
    name: f.current.plan.tokenName,
    symbol: f.current.plan.ticker,
    uri,
  });
  expect(f.release).toEqual(before);
});

it.each(['https://other.test', 'https://bundle.test:444'])(
  'rejects a public metadata image URI from another origin (%s)',
  async (site) => {
    await expect(verify(fixture(), site)).rejects.toThrow(
      'token identity or site',
    );
  },
);
it('rejects a different selected release ID even when public text matches', async () => {
  await expect(verify(fixture(), origin, 'b'.repeat(64))).rejects.toThrow(
    'token identity or site',
  );
});

it.each([
  'name',
  'symbol',
  'description',
  'website',
  'twitter',
  'telegram',
  'image',
] as const)('rejects a changed published %s', async (key) => {
  const f = fixture();
  f.metadata[key] = 'changed';
  f.release.metadata = JSON.stringify(f.metadata);
  await expect(verify(f)).rejects.toThrow('token identity or site');
});
it.each(['website', 'twitter', 'telegram'] as const)(
  'requires a saved nonempty %s to be present in the published document',
  async (key) => {
    const f = fixture();
    const metadata: Record<string, unknown> = { ...f.metadata };
    delete metadata[key];
    f.release.metadata = JSON.stringify(metadata);
    await expect(verify(f)).rejects.toThrow('token identity or site');
  },
);

it('permits omitted empty social links but refuses explicit empty values, matching Pump', async () => {
  const f = fixture();
  f.current.identity.website = '';
  f.current.identity.twitter = '';
  f.current.identity.telegram = '';
  f.release.source_document = JSON.stringify(f.current);
  const metadata: Record<string, unknown> = { ...f.metadata };
  delete metadata.website;
  delete metadata.twitter;
  delete metadata.telegram;
  f.release.metadata = JSON.stringify(metadata);
  expect((await verify(f)).uri).toBe(uri);
  metadata.website = '';
  f.release.metadata = JSON.stringify(metadata);
  await expect(verify(f)).rejects.toThrow('token identity or site');
});

it('checks detected artwork MIME against the retained MIME', async () => {
  const f = fixture();
  f.release.mime = 'image/jpeg';
  await expect(verify(f)).rejects.toThrow('Released artwork MIME differs.');
});
it('checks the SHA-256 of exact retained image bytes rather than only its header', async () => {
  const f = fixture();
  f.release.image[40] ^= 1;
  await expect(verify(f)).rejects.toThrow(
    'Released artwork differs from the saved image.',
  );
});
it('rejects malformed image bytes through the existing artwork inspector', async () => {
  const f = fixture();
  f.release.image = [1, 2, 3];
  await expect(verify(f)).rejects.toThrow('Use a PNG or JPEG image');
});
it('requires an uploaded saved image even if current and released sources match', async () => {
  const f = fixture();
  f.current.identity.artworkUrl = 'https://example.test/image.png';
  f.release.source_document = JSON.stringify(f.current);
  await expect(verify(f)).rejects.toThrow('exact saved identity and image');
});

it.each(['{', 'null', '[]', '3'])(
  'refuses unreadable published metadata (%s) with a fixed message',
  async (value) => {
    const f = fixture();
    f.release.metadata = value;
    await expect(verify(f)).rejects.toThrow(
      'Released metadata differs from the reviewed token identity or site.',
    );
  },
);
it.each(['{', 'null', '[]', '{}'])(
  'refuses unreadable saved release source (%s) with a fixed message',
  async (value) => {
    const f = fixture();
    f.release.source_document = value;
    await expect(verify(f)).rejects.toThrow(
      'Publish metadata for this exact saved identity and image first.',
    );
  },
);

it('preserves Pump compatibility with unconsumed metadata fields rather than comparing whole documents', async () => {
  const f = fixture();
  f.release.metadata = JSON.stringify({
    ...f.metadata,
    historicalAnnotation: 'retained',
  });
  expect((await verify(f)).uri).toBe(uri);
});
it('does not mutate the current project or retained release inputs', async () => {
  const f = fixture();
  const before = structuredClone(f);
  await verify(f);
  expect(f).toEqual(before);
});
