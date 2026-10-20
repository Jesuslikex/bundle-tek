import { inspectArtwork, isUploadedArtwork } from './artwork';
import { validateProjectDocument } from './workspace-project';

export class MetadataReleaseError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

// Only called after explicit consent to publish the saved token identity and image.
// No signing, mint creation, remote upload or arbitrary URL fetching occurs here.
export async function releaseLaunchMetadata(
  db: D1Database,
  owner: string,
  projectId: string,
  updatedAt: string,
  origin: string,
) {
  const base = new URL(origin);
  if (
    base.protocol !== 'https:' ||
    base.origin !== origin ||
    base.username ||
    base.password
  )
    throw new MetadataReleaseError(
      'Metadata needs a stable HTTPS site origin.',
      400,
    );
  const row = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!row) throw new MetadataReleaseError('Project not found.', 404);
  if (row.archived || row.updated_at !== updatedAt)
    throw new MetadataReleaseError(
      'Reload the active project before publishing metadata.',
      409,
    );
  const project = validateProjectDocument(JSON.parse(row.document));
  if (
    project.plan.chain !== 'Solana' ||
    !['PumpFun', 'StonkFun', 'LetsBonk', 'Surge', 'Meteora DBC'].includes(
      project.plan.launchpad,
    )
  )
    throw new MetadataReleaseError(
      'Choose a Solana PumpFun, StonkFun, LetsBonk, Surge or Meteora DBC launch.',
      400,
    );
  if (!isUploadedArtwork(project.identity.artworkUrl))
    throw new MetadataReleaseError(
      'Upload and save the exact artwork before publishing metadata.',
      400,
    );
  const imageId = project.identity.artworkUrl.split('/').at(-1)!;
  const artwork = await db
    .prepare(
      'SELECT data,mime,archived FROM project_artwork WHERE owner_id=? AND id=?',
    )
    .bind(owner, imageId)
    .first<{ data: number[]; mime: string; archived: number }>();
  if (!artwork || artwork.archived)
    throw new MetadataReleaseError(
      'Select active artwork owned by your account.',
      409,
    );
  const bytes = new Uint8Array(artwork.data);
  let mime: string;
  try {
    ({ mime } = inspectArtwork(bytes));
  } catch {
    throw new MetadataReleaseError(
      'Artwork integrity check failed. Upload it again.',
      409,
    );
  }
  if (mime !== artwork.mime || (await digest(bytes)) !== imageId)
    throw new MetadataReleaseError(
      'Artwork integrity check failed. Upload it again.',
      409,
    );
  const { tokenName: name, ticker: symbol, description } = project.plan;
  const { website, twitter, telegram } = project.identity;
  const publicFields = {
    name,
    symbol,
    description,
    ...(website && { website }),
    ...(twitter && { twitter }),
    ...(telegram && { telegram }),
  };
  // Include owner/project in the digest to avoid cross-account release collisions.
  // Neither identity is exposed in the public document.
  const id = await digest(
    new TextEncoder().encode(
      JSON.stringify([
        'launch-metadata-v1',
        owner,
        projectId,
        origin,
        publicFields,
        imageId,
      ]),
    ),
  );
  const url = `${origin}/api/launch/metadata/${id}`;
  if (url.length > 200)
    throw new MetadataReleaseError(
      'The metadata URL exceeds the launch URI limit.',
      400,
    );
  const metadataDocument = {
    ...publicFields,
    image: `${url}/image`,
    properties: {
      files: [{ uri: `${url}/image`, type: mime }],
      category: 'image',
    },
  };
  const metadata = JSON.stringify(metadataDocument);
  // The same database statement binds consent to the exact saved project and bytes.
  await db
    .prepare(
      `INSERT INTO launch_metadata_releases
    (id,owner_id,project_id,source_document,metadata,image,mime,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_projects
      WHERE owner_id=? AND id=? AND archived=0 AND updated_at=? AND document=?)
    AND EXISTS (SELECT 1 FROM project_artwork WHERE owner_id=? AND id=? AND archived=0 AND data=? AND mime=?)
    AND (SELECT COUNT(*) FROM launch_metadata_releases WHERE owner_id=?) < 100
    ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      id,
      owner,
      projectId,
      row.document,
      metadata,
      bytes,
      mime,
      new Date().toISOString(),
      owner,
      projectId,
      updatedAt,
      row.document,
      owner,
      imageId,
      bytes,
      mime,
      owner,
    )
    .run();
  const saved = await db
    .prepare(
      'SELECT metadata FROM launch_metadata_releases WHERE id=? AND owner_id=?',
    )
    .bind(id, owner)
    .first<{ metadata: string }>();
  if (!saved || saved.metadata !== metadata)
    throw new MetadataReleaseError(
      'Project or artwork changed, or the metadata release limit was reached.',
      409,
    );
  return {
    id,
    uri: url,
    metadata: metadataDocument,
    executionAllowed: false as const,
  };
}
