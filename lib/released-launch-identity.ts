import { inspectArtwork, isUploadedArtwork } from './artwork';
import {
  validateProjectDocument,
  type ProjectDocument,
} from './workspace-project';

export type ReleasedLaunchIdentity = {
  source_document: string;
  metadata: string;
  image: number[];
  mime: string;
};

const sourceDiffers = () =>
  new Error('Publish metadata for this exact saved identity and image first.');
const metadataDiffers = () =>
  new Error(
    'Released metadata differs from the reviewed token identity or site.',
  );

/** Verify the original Pump public-identity projection for any launch venue.
 * The caller supplies its admitted HTTPS origin/release ID and current owned
 * project. Funding, wallet selections and other non-identity settings are not
 * part of this comparison. No database, provider or URL is consulted here. */
export async function verifyReleasedLaunchIdentity(
  current: ProjectDocument,
  release: ReleasedLaunchIdentity,
  origin: string,
  releaseId: string,
): Promise<{ name: string; symbol: string; uri: string }> {
  let source: ProjectDocument;
  try {
    source = validateProjectDocument(JSON.parse(release.source_document));
  } catch {
    throw sourceDiffers();
  }
  const fields = (project: ProjectDocument) => [
    project.plan.tokenName,
    project.plan.ticker,
    project.plan.description,
    project.identity.artworkUrl,
    project.identity.website,
    project.identity.twitter,
    project.identity.telegram,
  ];
  if (
    JSON.stringify(fields(current)) !== JSON.stringify(fields(source)) ||
    !isUploadedArtwork(current.identity.artworkUrl)
  )
    throw sourceDiffers();

  const image = new Uint8Array(release.image);
  if (inspectArtwork(image).mime !== release.mime)
    throw new Error('Released artwork MIME differs.');
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', image)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  if (!current.identity.artworkUrl.endsWith('/' + sha))
    throw new Error('Released artwork differs from the saved image.');

  let metadata: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(release.metadata);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw metadataDiffers();
    metadata = value as Record<string, unknown>;
  } catch {
    throw metadataDiffers();
  }
  const uri = `${origin}/api/launch/metadata/${releaseId}`;
  if (
    metadata.image !== `${uri}/image` ||
    metadata.name !== current.plan.tokenName ||
    metadata.symbol !== current.plan.ticker ||
    metadata.description !== current.plan.description ||
    (['website', 'twitter', 'telegram'] as const).some(
      (key) => metadata[key] !== (current.identity[key] || undefined),
    )
  )
    throw metadataDiffers();

  return {
    name: current.plan.tokenName,
    symbol: current.plan.ticker,
    uri,
  };
}
