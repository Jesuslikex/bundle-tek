import { expect, it } from 'vitest';
import { volumePumpFixture } from '../test/volume-pump-simulation-fixture';
import { constructVolumeBundle } from './volume-bundle-construction';
import { validateVolumePumpRoute } from './volume-bundle-route';
it('matches only captured native exact-token Pump buy and sell roles and bounds', async () => {
  const { review, route } = await volumePumpFixture();
  expect(await validateVolumePumpRoute(review, route.identities)).toEqual(
    route,
  );
  expect(route).toMatchObject({
    constructionSha256: review.sha256,
    routeFieldsVerified: true,
    instructionsVerified: false,
    stateAdmissionRequired: true,
    programCodeAdmissionRequired: true,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it.each([
  'amount',
  'limit',
  'partial',
  'tracking',
  'discriminator',
  'extra',
  'account',
  'role',
  'creator',
  'fee',
])('refuses changed %s even after candidate reconstruction', async (kind) => {
  const { input, route } = await volumePumpFixture();
  const ids = structuredClone(route.identities);
  const raw = Uint8Array.from(atob(input.buy[0].dataBase64), (c) =>
    c.charCodeAt(0),
  );
  if (kind === 'amount') raw[8] ^= 1;
  if (kind === 'limit') raw[16] ^= 1;
  if (kind === 'partial') raw[25] = 1;
  if (kind === 'tracking') raw[24] = 1;
  if (kind === 'discriminator') raw[0] ^= 1;
  input.buy[0].dataBase64 = btoa(String.fromCharCode(...raw));
  if (kind === 'extra') input.buy.push(structuredClone(input.buy[0]));
  if (kind === 'account') input.buy[0].accounts[0].address = input.mint;
  if (kind === 'role') input.buy[0].accounts[0].role = 1;
  if (kind === 'creator') ids.creator = input.mint;
  if (kind === 'fee') ids.feeRecipient = input.mint;
  await expect(
    (async () =>
      validateVolumePumpRoute(await constructVolumeBundle(input), ids))(),
  ).rejects.toThrow();
});
