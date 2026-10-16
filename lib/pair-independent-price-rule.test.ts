import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it.each([false, null, undefined, 1, 'true'])(
  'treats nonboolean or missing market availability as unavailable in raw SQL: %s',
  (available) => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        'CREATE TABLE pair_order_first_reviews(id TEXT,document TEXT);CREATE TABLE pair_order_first_authorizations(review_id TEXT,document TEXT);',
      );
      db.exec(
        readFileSync(
          'drizzle/0091_pair_order_independent_price_consent.sql',
          'utf8',
        ),
      );
      db.prepare('INSERT INTO pair_order_first_reviews VALUES(?,?)').run(
        'review',
        JSON.stringify({ review: { marketComparison: { available } } }),
      );
      const insert = (ack: unknown) =>
        db
          .prepare('INSERT INTO pair_order_first_authorizations VALUES(?,?)')
          .run(
            'review',
            JSON.stringify({
              consent: { acknowledgeUnavailableIndependentPrice: ack },
            }),
          );
      for (const ack of [undefined, false, null, 1, 'true'])
        expect(() => insert(ack)).toThrow('acknowledgement');
      expect(() => insert(true)).not.toThrow();
    } finally {
      db.close();
    }
  },
);
it('allows an available comparison without the missing-price acknowledgement, but still requires its boolean field', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE pair_order_first_reviews(id TEXT,document TEXT);CREATE TABLE pair_order_first_authorizations(review_id TEXT,document TEXT);',
    );
    db.exec(
      readFileSync(
        'drizzle/0091_pair_order_independent_price_consent.sql',
        'utf8',
      ),
    );
    db.prepare('INSERT INTO pair_order_first_reviews VALUES(?,?)').run(
      'review',
      JSON.stringify({ review: { marketComparison: { available: true } } }),
    );
    const insert = (ack: unknown) =>
      db
        .prepare('INSERT INTO pair_order_first_authorizations VALUES(?,?)')
        .run(
          'review',
          JSON.stringify({
            consent: { acknowledgeUnavailableIndependentPrice: ack },
          }),
        );
    expect(() => insert(false)).not.toThrow();
    expect(() => insert(undefined)).toThrow('acknowledgement');
    expect(() => insert(1)).toThrow('acknowledgement');
  } finally {
    db.close();
  }
});
