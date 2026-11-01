import { describe, expect, it } from 'vitest';
import { frontMevCap, frontMevRefusal } from './front-mev-limit';

const base = { frontCount: 5, maxFrontMevCount: 4 };

describe('front mev cap resolution', () => {
  it('does nothing without any front wallets', () => {
    expect(frontMevCap({ ...base, frontCount: 0 })).toBeNull();
    expect(frontMevRefusal({ ...base, frontCount: 0 })).toBeNull();
  });

  it('does nothing when the mint supplies no cap', () => {
    expect(frontMevCap({ frontCount: 99 })).toBeNull();
    expect(frontMevRefusal({ frontCount: 99 })).toBeNull();
    expect(frontMevRefusal({ frontCount: 99, maxFrontMevCount: 0 })).toBeNull();
  });

  it('uses the plain cap below the migration threshold', () => {
    expect(
      frontMevCap({ ...base, migrationThreshold: 100, buy: 50 }),
    ).toMatchObject({ cap: 4, postMigration: false });
  });

  it('switches to the post-migration cap at the threshold', () => {
    expect(
      frontMevCap({ ...base, migrationThreshold: 100, buy: 100 }),
    ).toMatchObject({ cap: 4, postMigration: true });
    expect(
      frontMevCap({
        ...base,
        maxFrontMevPostMigration: 2,
        migrationThreshold: 100,
        buy: 150,
      }),
    ).toMatchObject({ cap: 2, postMigration: true });
  });

  it('falls back to the plain cap when no post-migration value is given', () => {
    expect(
      frontMevCap({ ...base, migrationThreshold: 100, buy: 150 }),
    ).toMatchObject({ cap: 4 });
  });

  it('treats a missing threshold as below it', () => {
    expect(frontMevCap({ ...base, buy: 999 })).toMatchObject({
      postMigration: false,
    });
  });
});

describe('front mev refusals', () => {
  it('accepts a count at the cap', () => {
    expect(frontMevRefusal({ ...base, frontCount: 4 })).toBeNull();
  });

  it('refuses above the plain cap', () => {
    expect(frontMevRefusal(base)).toBe(
      'Maximum Front MEV wallets is 4. Current: 5.',
    );
  });

  it('refuses with the post-migration wording at the threshold', () => {
    expect(
      frontMevRefusal({
        frontCount: 5,
        maxFrontMevCount: 4,
        maxFrontMevPostMigration: 3,
        migrationThreshold: 100,
        buy: 120,
      }),
    ).toBe(
      'With this buy amount, maximum Front MEV wallets is 3. Current: 5. Reduce Front MEV count first.',
    );
  });

  it('accepts the higher plain cap below the threshold even if it exceeds the post one', () => {
    // 4 wallets is over a post-migration cap of 3 but fine while below.
    expect(
      frontMevRefusal({
        frontCount: 4,
        maxFrontMevCount: 4,
        maxFrontMevPostMigration: 3,
        migrationThreshold: 100,
        buy: 50,
      }),
    ).toBeNull();
  });

  it('lets an explicit post-migration zero disable the cap after migration', () => {
    // `?? ` keeps 0, and the inner truth test then skips the refusal.
    expect(
      frontMevRefusal({
        frontCount: 9,
        maxFrontMevCount: 4,
        maxFrontMevPostMigration: 0,
        migrationThreshold: 100,
        buy: 150,
      }),
    ).toBeNull();
  });
});
